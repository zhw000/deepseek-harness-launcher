import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { abortError, renameWithRetry, sleep } from './util'

/** The fetch the launcher uses: Electron's net.fetch in the app, global fetch in tests. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export const USER_AGENT = 'dsh-launcher (+https://github.com/deepseek-ai/deepseek-harness)'

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`请求失败（HTTP ${status}）：${url}`)
    this.name = 'HttpError'
  }
}

export interface RequestOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** Attempts for transient failures (network errors, 5xx, 429). */
  attempts?: number
}

function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500 || error.status === 429
  return !(error instanceof Error && (error.name === 'AbortError' || error.name === 'CancelledError'))
}

async function withRetry<T>(attempts: number, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      if (attempt >= attempts || !isTransient(error)) throw error
      await sleep(500 * 2 ** (attempt - 1), signal)
    }
  }
}

async function request(fetchFn: FetchFn, url: string, options: RequestOptions): Promise<Response> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 30_000)]
  if (options.signal) signals.push(options.signal)
  const response = await fetchFn(url, {
    headers: { 'user-agent': USER_AGENT, ...options.headers },
    signal: AbortSignal.any(signals),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new HttpError(response.status, url)
  }
  return response
}

export function getJson<T>(fetchFn: FetchFn, url: string, options: RequestOptions = {}): Promise<T> {
  return withRetry(options.attempts ?? 3, options.signal, async () => {
    const response = await request(fetchFn, url, { ...options, headers: { accept: 'application/json', ...options.headers } })
    return await response.json() as T
  })
}

export function getText(fetchFn: FetchFn, url: string, options: RequestOptions = {}): Promise<string> {
  return withRetry(options.attempts ?? 3, options.signal, async () => {
    const response = await request(fetchFn, url, options)
    return await response.text()
  })
}

export interface DownloadOptions {
  signal?: AbortSignal
  onProgress?: (received: number, total: number | null) => void
  /** Expected hex SHA-256; a mismatch deletes the file and fails. */
  sha256?: string
  /** Abort when no bytes arrive for this long. */
  idleTimeoutMs?: number
  attempts?: number
}

/** Stream `url` to `dest` through a `.part` file, verifying the digest before the final rename. */
export function downloadFile(fetchFn: FetchFn, url: string, dest: string, options: DownloadOptions = {}): Promise<void> {
  return withRetry(options.attempts ?? 3, options.signal, () => downloadOnce(fetchFn, url, dest, options))
}

async function downloadOnce(fetchFn: FetchFn, url: string, dest: string, options: DownloadOptions): Promise<void> {
  const idle = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal
  const idleMs = options.idleTimeoutMs ?? 60_000
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle.abort(new Error(`下载超时：${idleMs / 1000} 秒内没有收到数据`)), idleMs)
  }
  const part = `${dest}.part`
  arm()
  try {
    const response = await fetchFn(url, { headers: { 'user-agent': USER_AGENT }, signal })
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined)
      throw new HttpError(response.status, url)
    }
    const total = Number(response.headers.get('content-length')) || null
    const hash = createHash('sha256')
    const out = createWriteStream(part)
    let received = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm()
        hash.update(value)
        received += value.byteLength
        if (!out.write(value)) await once(out, 'drain')
        options.onProgress?.(received, total)
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()))
    } catch (error) {
      out.destroy()
      throw signal.aborted ? abortError(signal) : error
    }
    if (total !== null && received !== total) throw new Error(`下载不完整：收到 ${received} / ${total} 字节`)
    const digest = hash.digest('hex')
    if (options.sha256 !== undefined && digest !== options.sha256.toLowerCase()) {
      throw new Error(`SHA-256 校验失败：期望 ${options.sha256}，实际 ${digest}`)
    }
    await renameWithRetry(part, dest)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
