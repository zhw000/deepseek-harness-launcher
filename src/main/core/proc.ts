import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'
import { abortError, TextTail } from './util'

export type OutputStream = 'stdout' | 'stderr'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onOutput?: (text: string, stream: OutputStream) => void
  /** Characters of combined output kept in the result. */
  tailChars?: number
}

export interface RunResult {
  code: number
  /** Tail of stdout and stderr, interleaved as received. */
  output: string
}

/**
 * Run a command without a shell and collect its output. Aborting kills the whole
 * process tree, since npm and pnpm fan out into their own children.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortError(options.signal))
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A process group on POSIX lets killTree reach grandchildren.
      detached: process.platform !== 'win32',
    })
    const tail = new TextTail(options.tailChars ?? 64_000)
    const collect = (stream: OutputStream) => (chunk: string) => {
      tail.append(chunk)
      options.onOutput?.(chunk, stream)
    }
    child.stdout.setEncoding('utf8').on('data', collect('stdout'))
    child.stderr.setEncoding('utf8').on('data', collect('stderr'))
    let aborted = false
    const onAbort = () => {
      aborted = true
      if (child.pid !== undefined) void killTree(child.pid)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code, signal) => {
      cleanup()
      if (aborted && options.signal) return reject(abortError(options.signal))
      resolve({ code: code ?? (signal ? 1 : 0), output: tail.toString() })
    })
  })
}

/** Kill a process and everything it spawned. */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('close', () => resolve())
      killer.on('error', () => resolve())
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    resolve()
  })
}

/** Windows keeps whatever case the variable was created with (usually `Path`). */
export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
}

export function prependPath(env: NodeJS.ProcessEnv, dirs: readonly string[]): NodeJS.ProcessEnv {
  const key = pathKey(env)
  return { ...env, [key]: [...dirs, env[key]].filter(Boolean).join(delimiter) }
}

export function appendPath(env: NodeJS.ProcessEnv, dirs: readonly string[]): NodeJS.ProcessEnv {
  const key = pathKey(env)
  return { ...env, [key]: [env[key], ...dirs].filter(Boolean).join(delimiter) }
}

/** Delete variables by name regardless of case, as Windows treats them. */
export function deleteEnv(env: NodeJS.ProcessEnv, names: readonly string[]): void {
  const wanted = new Set(names.map(name => name.toUpperCase()))
  for (const key of Object.keys(env)) {
    if (wanted.has(key.toUpperCase())) delete env[key]
  }
}
