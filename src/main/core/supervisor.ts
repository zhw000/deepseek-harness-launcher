import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LogLine, LogStream, ProcessStatus } from '../../shared/types'
import { killTree } from './proc'
import { ensureDir, LineSplitter, sleep, stripAnsi } from './util'

export const SHUTDOWN_MESSAGE = 'dsh-launcher:shutdown'
const BRIDGE_FILE = 'dsh-launcher-bridge.mjs'

/**
 * Preloaded into dsh with `--import`. Windows has no deliverable SIGTERM, so the
 * launcher asks over the IPC channel and the bridge replays it as the SIGTERM event
 * dsh already handles with its bounded graceful drain. A lost launcher (the channel
 * disconnects) also stops dsh, so no orphan keeps holding the port.
 */
export const BRIDGE_SOURCE = `// Written by DSH Launcher; preloaded into dsh with --import.
if (typeof process.send === 'function') {
  const stop = () => process.emit('SIGTERM', 'SIGTERM')
  process.on('message', (message) => {
    if (message && message.type === '${SHUTDOWN_MESSAGE}') stop()
  })
  process.on('disconnect', stop)
  // Never keep dsh alive just because the launcher holds the channel open.
  process.channel?.unref()
}
`

export async function ensureBridge(binDir: string): Promise<string> {
  await ensureDir(binDir)
  const path = join(binDir, BRIDGE_FILE)
  if (await readFile(path, 'utf8').catch(() => null) !== BRIDGE_SOURCE) await writeFile(path, BRIDGE_SOURCE)
  return path
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

export async function findFreePort(start: number, host = '127.0.0.1', attempts = 50): Promise<number | null> {
  for (let port = start; port < start + attempts && port <= 65535; port++) {
    if (await isPortFree(port, host)) return port
  }
  return null
}

/** Launcher flags must precede app arguments; pull `--patch <file>` pairs to the front. */
export function splitLaunchArgs(args: readonly string[]): { launcherArgs: string[]; appArgs: string[] } {
  const launcherArgs: string[] = []
  const appArgs: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--patch' && index + 1 < args.length) launcherArgs.push(arg, args[++index])
    else if (arg.startsWith('--patch=')) launcherArgs.push(arg)
    else appArgs.push(arg)
  }
  return { launcherArgs, appArgs }
}

export interface LaunchSpec {
  node: string
  dshBin: string
  bridge: string
  profile: string
  version: string
  port: number
  cwd: string
  env: NodeJS.ProcessEnv
  launcherArgs: string[]
  appArgs: string[]
  logFile: string | null
  readyTimeoutMs?: number
}

export function idleStatus(): ProcessStatus {
  return {
    phase: 'stopped', pid: null, profile: null, version: null, port: null, url: null,
    startedAt: null, exitCode: null, error: null, diagnostics: null, failedPlugin: null,
  }
}

const MAX_LINES = 5000
const HOST = '127.0.0.1'

type SupervisorEvents = { status: [ProcessStatus]; lines: [LogLine[]] }

function within(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** `dsh web` prints its one-time sign-in URL (`/?token=…`) once the whole Loader tree has settled. */
const ANNOUNCE = /^dsh web:\s+(https?:\/\/\S+)/
/** dsh names the package it could not load: "failed to import loader entry <id> (<package>)". */
const FAILED_ENTRY = /loader entry \S+ \(([^)]+)\)/g
/** A thrown error as Node prints it: "Error: …", "TypeError: …", "SyntaxError: …". */
const THROWN_ERROR = /^(?:[A-Z]\w*)?(?:Error|Exception):\s+\S/
/** Source echoed from the failing file rather than a message. */
const SOURCE_ECHO = /(?:^\s*(?:throw|import|export|const|let|var|function|return|await)\b)|\$\{|;\s*$|[{}]\s*$|^\^+$/
/** Builds that never announce a URL count as ready this long after the port first answers. */
const ANNOUNCE_GRACE_MS = 15_000

/** Hide the sign-in token wherever output is shown or stored. */
export function maskToken(text: string): string {
  return text.replace(/([?&]token=)[^&\s]+/g, '$1***')
}

/** Runs one dsh web process: output capture, readiness, graceful stop, crash reporting. */
export class DshSupervisor extends EventEmitter<SupervisorEvents> {
  status: ProcessStatus = idleStatus()
  private child: ChildProcess | null = null
  private exited: Promise<void> = Promise.resolve()
  private stopping = false
  private lines: LogLine[] = []
  private seq = 0
  private logStream: WriteStream | null = null
  private portInUse = false
  private spawnError: string | null = null
  private runStartSeq = 0
  private announcedUrl: string | null = null
  private failedEntry: string | null = null

  get running(): boolean {
    return this.child !== null
  }

  getLines(): LogLine[] {
    return this.lines.slice()
  }

  clearLines(): void {
    this.lines = []
  }

  /** Append a launcher-authored line to the console. */
  note(text: string): void {
    this.push('system', [text])
  }

  /** Spawn dsh and resolve once it announces its sign-in URL; reject if it exits or never gets there. */
  async start(spec: LaunchSpec): Promise<void> {
    if (this.child !== null) throw new Error('dsh 已在运行')
    this.stopping = false
    this.portInUse = false
    this.spawnError = null
    this.announcedUrl = null
    this.failedEntry = null
    this.runStartSeq = this.seq
    const args = [
      '--import', pathToFileURL(spec.bridge).href, spec.dshBin,
      '--profile', spec.profile, ...spec.launcherArgs,
      '--no-open', '--port', String(spec.port), ...spec.appArgs,
    ]
    this.logStream = spec.logFile === null ? null : createWriteStream(spec.logFile, { flags: 'a' })
    this.note(`启动 dsh ${spec.version}（配置 ${spec.profile}，端口 ${spec.port}，工作区 ${spec.cwd}）`)
    const child = spawn(spec.node, args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
    })
    this.child = child
    this.setStatus({
      ...idleStatus(), phase: 'starting', pid: child.pid ?? null, profile: spec.profile,
      version: spec.version, port: spec.port, startedAt: new Date().toISOString(),
    })
    this.exited = new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer)
        this.finish(child, code, signal)
        resolve()
      }
      // Prefer 'close' so buffered output is flushed, but do not wait forever on
      // grandchildren that inherited the pipes.
      child.once('exit', (code, signal) => {
        timer = setTimeout(() => finish(code, signal), 2000)
      })
      child.once('close', (code, signal) => finish(code, signal))
      child.once('error', (error) => {
        if (child.pid === undefined) {
          this.spawnError = `无法启动 Node.js：${error.message}`
          finish(null, null)
        }
      })
    })
    this.pipe(child, 'stdout')
    this.pipe(child, 'stderr')
    let url: string
    try {
      url = await this.waitReady(child, `http://${HOST}:${spec.port}/`, spec.readyTimeoutMs ?? 180_000)
    } catch (error) {
      if (this.child === child) {
        await this.stop()
        this.setStatus({ ...this.status, phase: 'crashed', error: (error as Error).message })
      }
      throw error
    }
    this.setStatus({ ...this.status, phase: 'running', url })
    this.note(`dsh 已就绪：${maskToken(url)}`)
  }

  /** Ask dsh to drain gracefully; kill the process tree if it has not exited in time. */
  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child
    if (child === null) return
    if (!this.stopping) {
      this.stopping = true
      this.setStatus({ ...this.status, phase: 'stopping' })
      this.note('正在停止 dsh…')
      if (child.connected) child.send({ type: SHUTDOWN_MESSAGE }, () => undefined)
    }
    if (await within(this.exited, timeoutMs)) return
    this.note('dsh 未在时限内退出，强制结束进程树')
    if (child.pid !== undefined) await killTree(child.pid)
    await within(this.exited, 5000)
  }

  private async waitReady(child: ChildProcess, baseUrl: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let answeredAt: number | null = null
    while (this.child === child) {
      if (this.announcedUrl !== null) return this.announcedUrl
      if (answeredAt === null && await answers(baseUrl)) answeredAt = Date.now()
      if (answeredAt !== null && Date.now() - answeredAt > ANNOUNCE_GRACE_MS) return baseUrl
      if (Date.now() > deadline) throw new Error(`等待 dsh 就绪超时（${Math.round(timeoutMs / 1000)} 秒），请查看日志`)
      await sleep(300)
    }
    throw new Error(this.status.error ?? 'dsh 在就绪前退出')
  }

  private pipe(child: ChildProcess, stream: 'stdout' | 'stderr'): void {
    const source = child[stream]
    if (source === null) return
    const splitter = new LineSplitter()
    source.setEncoding('utf8')
    source.on('data', (chunk: string) => this.push(stream, splitter.push(chunk)))
    source.on('end', () => this.push(stream, splitter.flush()))
  }

  private push(stream: LogStream, texts: string[]): void {
    if (texts.length === 0) return
    const time = Date.now()
    const lines = texts.map((raw) => {
      const text = stripAnsi(raw)
      if (stream !== 'system') this.inspect(text)
      return { seq: ++this.seq, time, stream, text: maskToken(text) }
    })
    for (const line of lines) this.logStream?.write(`${stream === 'system' ? '[launcher] ' : ''}${line.text}\n`)
    this.lines.push(...lines)
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    this.emit('lines', lines)
  }

  private inspect(text: string): void {
    const announced = ANNOUNCE.exec(text.trim())
    if (announced) this.announcedUrl = announced[1]
    // The message nests entries outside in: "failed to apply … (cordis:include): failed to
    // import … (dsh-better-sidebar)". The innermost package name is the one to blame, and
    // dsh's own entries (cordis:include) are not installed packages.
    for (const match of text.matchAll(FAILED_ENTRY)) {
      if (!match[1].includes(':')) this.failedEntry = match[1]
    }
    const diagnostics = /Full diagnostics:\s*(.+?\.log)\s*$/.exec(text)
    if (diagnostics) this.setStatus({ ...this.status, diagnostics: diagnostics[1] })
    if (text.includes('EADDRINUSE')) this.portInUse = true
  }

  private finish(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    const expected = this.stopping
    this.stopping = false
    const previous = this.status
    if (expected) {
      this.note(`dsh 已停止（退出码 ${code ?? signal ?? '未知'}）`)
      this.setStatus({ ...idleStatus(), exitCode: code, diagnostics: previous.diagnostics })
    } else {
      const reason = this.failureReason(code, signal)
      this.note(`dsh 意外退出：${reason}`)
      this.setStatus({
        ...idleStatus(), phase: 'crashed', exitCode: code, error: reason, diagnostics: previous.diagnostics,
        failedPlugin: this.failedEntry,
        profile: previous.profile, version: previous.version, port: previous.port,
      })
    }
    this.logStream?.end()
    this.logStream = null
  }

  private failureReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (this.spawnError !== null) return this.spawnError
    if (this.portInUse) return `端口 ${this.status.port} 已被占用`
    // Node echoes the offending source line before the error itself, and dsh ends a failed boot
    // with stack frames and a "Full diagnostics:" pointer. None of those is the message.
    const candidates = this.lines
      .filter(line => line.seq > this.runStartSeq && line.stream === 'stderr')
      .map(line => line.text.trim())
      .filter(text => text !== '' && !text.startsWith('at ') && !text.startsWith('Full diagnostics:') && !SOURCE_ECHO.test(text))
    const reason = candidates.find(text => THROWN_ERROR.test(text))
      ?? candidates.find(text => /error|fail|fatal|cannot|unable/i.test(text))
      ?? candidates.at(-1)
    const base = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`
    return reason === undefined ? base : `${base}：${reason.length > 400 ? `${reason.slice(0, 400)}…` : reason}`
  }

  private setStatus(status: ProcessStatus): void {
    this.status = status
    this.emit('status', status)
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
    await response.body?.cancel().catch(() => undefined)
    return true
  } catch {
    return false
  }
}
