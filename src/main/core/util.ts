import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Write through a temporary sibling and rename, so readers never see a torn file. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content)
  try {
    await renameWithRetry(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, undefined, 2) + '\n')
}

/** Windows antivirus and indexers briefly hold fresh files open; retry the rename a few times. */
export async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await sleep(150 * attempt)
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class CancelledError extends Error {
  constructor(message = '已取消') {
    super(message)
    this.name = 'CancelledError'
  }
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new CancelledError()
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// CSI and OSC escape sequences emitted by colored CLI output. Built from char codes
// so the source stays free of raw control characters.
const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)
const BEL = String.fromCharCode(0x07)
const ANSI = new RegExp(
  String.raw`[${ESC}${CSI}][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?${BEL})`
  + String.raw`|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))`,
  'g',
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Splits streamed text into complete lines, holding back a trailing partial line. */
export class LineSplitter {
  private rest = ''

  push(chunk: string): string[] {
    const text = this.rest + chunk
    const parts = text.split(/\r?\n/)
    this.rest = parts.pop() ?? ''
    // A bare carriage return redraws the line (progress bars); keep only what stays visible.
    return parts.map(visibleTail)
  }

  flush(): string[] {
    const rest = this.rest
    this.rest = ''
    return rest === '' ? [] : [visibleTail(rest)]
  }
}

function visibleTail(line: string): string {
  return line.slice(line.lastIndexOf('\r') + 1)
}

/** Keeps the last `limit` characters of appended text. */
export class TextTail {
  private text = ''

  constructor(private readonly limit: number) {}

  append(chunk: string): void {
    this.text += chunk
    if (this.text.length > this.limit * 2) this.text = this.text.slice(-this.limit)
  }

  toString(): string {
    return this.text.length > this.limit ? this.text.slice(-this.limit) : this.text
  }
}

/** Run `worker` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(lanes)
  return results
}

/** Split a command-line string into arguments, honoring single and double quotes. */
export function splitArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }
  if (quote !== null) throw new Error('额外参数中的引号没有闭合')
  if (started) args.push(current)
  return args
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}
