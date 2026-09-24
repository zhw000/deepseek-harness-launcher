import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runtimeFromDir } from '../src/main/core/node-runtime'
import { launcherPaths } from '../src/main/core/paths'
import { writeShims } from '../src/main/core/pnpm'
import { DshSupervisor, ensureBridge, findFreePort, isPortFree } from '../src/main/core/supervisor'
import { TaskRunner } from '../src/main/core/tasks'
import { sleep } from '../src/main/core/util'

const BACKSLASH = String.fromCharCode(92)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('task runner', () => {
  it('runs tasks one at a time in order', async () => {
    const runner = new TaskRunner()
    const order: string[] = []
    const a = runner.run('a', async () => {
      order.push('a:start')
      await sleep(30)
      order.push('a:end')
      return 1
    })
    const b = runner.run('b', async () => {
      order.push('b')
      return 2
    })
    expect(runner.list().map(task => task.status)).toEqual(['queued', 'queued'])
    expect(await Promise.all([a, b])).toEqual([1, 2])
    expect(order).toEqual(['a:start', 'a:end', 'b'])
    expect(runner.list().map(task => task.status)).toEqual(['done', 'done'])
  })

  it('cancels running and queued work', async () => {
    const runner = new TaskRunner()
    const a = runner.run('a', task => sleep(10_000, task.signal))
    const b = runner.run('b', async () => 'never')
    const [second, first] = runner.list()
    runner.cancel(second.id)
    await sleep(10)
    runner.cancel(first.id)
    await expect(a).rejects.toThrow()
    await expect(b).rejects.toThrow()
    expect(runner.list().map(task => task.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('starts parallel work at once, beside the queue', async () => {
    const runner = new TaskRunner()
    const order: string[] = []
    const slow = runner.run('pnpm', async () => {
      await sleep(50)
      order.push('pnpm')
    })
    const index = runner.run('index', async () => {
      order.push('index')
    }, { parallel: true })
    await Promise.all([slow, index])
    expect(order).toEqual(['index', 'pnpm'])
    // Closing cancels parallel work too, and still waits for it to wind down.
    let finished = false
    const late = runner.run('late', async () => {
      await sleep(30)
      finished = true
    }, { parallel: true })
    await runner.close()
    expect(finished).toBe(true)
    await expect(late).rejects.toThrow()
  })

  it('records failures with their log', async () => {
    const runner = new TaskRunner()
    await expect(runner.run('x', async (task) => {
      task.log('hello\n')
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const [task] = runner.list()
    expect(task).toMatchObject({ status: 'failed', error: 'boom' })
    expect(runner.logOf(task.id)).toContain('hello')
  })
})

describe('pnpm shims', () => {
  it('address the runtime relative to the shim so non-ASCII roots survive cmd.exe', async () => {
    const paths = launcherPaths(join(dir, '用户'))
    const runtime = runtimeFromDir(join(paths.node, 'v24.21.0'), '24.21.0', 'win32')
    await writeShims(paths, runtime, 'win32')
    const cmd = await readFile(join(paths.bin, 'pnpm.cmd'), 'utf8')
    expect(cmd).toMatch(/^@echo off/)
    expect(cmd).toContain('%~dp0')
    expect(cmd).toContain('node.exe')
    expect(cmd).toContain('pnpm.cjs')
    expect(cmd).not.toContain('用户')
    const sh = await readFile(join(paths.bin, 'pnpm'), 'utf8')
    expect(sh).toContain(`sed -e 's,${BACKSLASH}${BACKSLASH},/,g'`)
    expect(sh).toContain('"$basedir/../node/v24.21.0/node.exe"')
  })
})

/** Mimics `dsh web`: the --port app flag, a startup crash, and dsh's SIGTERM drain. */
const FAKE_DSH = `
import { createServer } from 'node:http'
const args = process.argv.slice(2)
if (args.includes('--crash')) {
  console.error('fatal: plugin boot failed')
  console.error('Full diagnostics: /tmp/dsh/logs/startup-1.log')
  process.exit(3)
}
const port = Number(args[args.indexOf('--port') + 1])
console.log('profile=' + args[args.indexOf('--profile') + 1])
const server = createServer((request, response) => response.end('ok'))
server.listen(port, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + port + '/?token=s3cret'))
process.on('SIGTERM', () => {
  console.log('draining')
  server.closeAllConnections()
  server.close(() => process.exit(0))
})
`

describe('supervisor', () => {
  async function launch(supervisor: DshSupervisor, appArgs: string[] = []) {
    const dshBin = join(dir, 'fake-dsh.mjs')
    await writeFile(dshBin, FAKE_DSH)
    const port = (await findFreePort(38_000))!
    await supervisor.start({
      node: process.execPath, dshBin, bridge: await ensureBridge(dir), profile: 'web', version: '0.0.0-test', port,
      cwd: dir, env: process.env, launcherArgs: [], appArgs, logFile: join(dir, 'run.log'), readyTimeoutMs: 15_000,
    })
    return port
  }

  it('starts, reports ready, and stops through dsh’s own SIGTERM drain', async () => {
    const supervisor = new DshSupervisor()
    const port = await launch(supervisor)
    expect(supervisor.status).toMatchObject({ phase: 'running', url: `http://127.0.0.1:${port}/?token=s3cret`, profile: 'web' })
    expect(await isPortFree(port)).toBe(false)
    await supervisor.stop(8000)
    expect(supervisor.status).toMatchObject({ phase: 'stopped', exitCode: 0 })
    const texts = supervisor.getLines().map(line => line.text)
    expect(texts).toContain('profile=web')
    expect(texts).toContain('draining')
    expect(texts).toContain(`dsh web: http://127.0.0.1:${port}/?token=***`)
    expect(texts.some(text => text.includes("s3cret"))).toBe(false)
    expect(await readFile(join(dir, 'run.log'), 'utf8')).toContain('draining')
  })

  it('reports a crash before readiness with its diagnostics file', async () => {
    const supervisor = new DshSupervisor()
    await expect(launch(supervisor, ['--crash'])).rejects.toThrow()
    expect(supervisor.status.phase).toBe('crashed')
    expect(supervisor.status.exitCode).toBe(3)
    expect(supervisor.status.error).toContain('fatal: plugin boot failed')
    expect(supervisor.status.diagnostics).toBe('/tmp/dsh/logs/startup-1.log')
  })

  it('finds a free port next to a busy one', async () => {
    const busy = (await findFreePort(39_000))!
    const server: Server = createServer()
    await new Promise<void>(resolve => server.listen(busy, '127.0.0.1', resolve))
    try {
      expect(await isPortFree(busy)).toBe(false)
      expect(await findFreePort(busy)).toBeGreaterThan(busy)
    } finally {
      server.close()
    }
  })
})

/** The shape of a dsh boot that a third-party plugin broke, as Node and dsh actually print it. */
const PLUGIN_FAILURE = [
  'file:///C:/app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1545',
  '\t\tthrow new Error(\`\${binName}: \${stage}: \${detail}\${stack}\`, { cause });',
  '\t\t      ^',
  '',
  "Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry better-sidebar (dsh-better-sidebar): The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'",
  'file:///E:/home/profiles/web/node_modules/dsh-better-sidebar/lib/index.js:9',
  'import { SettingsConflictError, settingsNamespace } from "@deepseek-ai/dsh-settings";',
  '    at #asyncInstantiate (node:internal/modules/esm/module_job:455:21)',
  'Full diagnostics: C:/Users/x/.dsh/logs/startup-2026-1.log',
]

describe('boot failure caused by a plugin', () => {
  it('reports the thrown error, not the echoed source line, and names the plugin to disable', async () => {
    const dshBin = join(dir, 'failing-dsh.mjs')
    await writeFile(dshBin, PLUGIN_FAILURE.map(line => `console.error(${JSON.stringify(line)})`).join('\n') + '\nprocess.exit(1)\n')
    const supervisor = new DshSupervisor()
    await expect(supervisor.start({
      node: process.execPath, dshBin, bridge: await ensureBridge(dir), profile: 'web', version: '0.1.5-rc.2',
      port: (await findFreePort(38_500))!, cwd: dir, env: process.env, launcherArgs: [], appArgs: [],
      logFile: null, readyTimeoutMs: 10_000,
    })).rejects.toThrow()
    expect(supervisor.status.phase).toBe('crashed')
    // The outermost "Error: …" line, not the echoed source and not the inner TypeError.
    expect(supervisor.status.error).toContain('Error: dsh: plugin tree failed to load')
    expect(supervisor.status.error).not.toContain('throw new Error')
    expect(supervisor.status.failedPlugin).toBe('dsh-better-sidebar')
    expect(supervisor.status.diagnostics).toBe('C:/Users/x/.dsh/logs/startup-2026-1.log')
  })
})
