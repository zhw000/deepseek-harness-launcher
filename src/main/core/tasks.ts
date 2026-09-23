import { EventEmitter } from 'node:events'
import type { TaskInfo } from '../../shared/types'
import { CancelledError, errorMessage, TextTail } from './util'

export interface TaskHandle {
  id: string
  signal: AbortSignal
  /** Rename the task once the work knows what it covers, e.g. after a batch is collected. */
  title(text: string): void
  progress(fraction: number | null, detail?: string): void
  log(text: string): void
}

interface TaskRecord {
  info: TaskInfo
  controller: AbortController
  log: TextTail
}

const KEEP_FINISHED = 30

type TaskEvents = { change: []; log: [id: string, text: string] }

/**
 * Serializes every mutating operation (downloads, installs, pnpm runs) through one
 * queue so they never race on the same files. Work must not queue another task and
 * wait for it, or the queue deadlocks.
 */
export class TaskRunner extends EventEmitter<TaskEvents> {
  private readonly records = new Map<string, TaskRecord>()
  private queue: Promise<unknown> = Promise.resolve()
  private counter = 0
  private closed = false

  /** Stop accepting work, cancel running/queued jobs, and wait for their cleanup. */
  async close(): Promise<void> {
    this.closed = true
    for (const record of this.records.values()) {
      if (record.info.endedAt === null) record.controller.abort(new CancelledError())
    }
    await this.queue
  }

  /** Newest first. */
  list(): TaskInfo[] {
    return [...this.records.values()].map(record => ({ ...record.info })).reverse()
  }

  logOf(id: string): string {
    return this.records.get(id)?.log.toString() ?? ''
  }

  cancel(id: string): void {
    this.records.get(id)?.controller.abort(new CancelledError())
  }

  run<T>(title: string, work: (task: TaskHandle) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CancelledError())
    const record: TaskRecord = {
      info: {
        id: `task-${Date.now().toString(36)}-${++this.counter}`,
        title,
        status: 'queued',
        progress: null,
        detail: '排队中',
        error: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
      },
      controller: new AbortController(),
      log: new TextTail(256_000),
    }
    this.records.set(record.info.id, record)
    this.emit('change')
    const result = this.queue.then(() => this.execute(record, work))
    this.queue = result.catch(() => undefined)
    return result
  }

  private async execute<T>(record: TaskRecord, work: (task: TaskHandle) => Promise<T>): Promise<T> {
    const { info, controller } = record
    try {
      if (controller.signal.aborted) throw new CancelledError()
      info.status = 'running'
      info.detail = ''
      info.startedAt = new Date().toISOString()
      this.emit('change')
      const handle: TaskHandle = {
        id: info.id,
        signal: controller.signal,
        title: (text) => {
          info.title = text
          this.emit('change')
        },
        progress: (fraction, detail) => {
          info.progress = fraction === null ? null : Math.max(0, Math.min(1, fraction))
          if (detail !== undefined) info.detail = detail
          this.emit('change')
        },
        log: (text) => {
          record.log.append(text)
          this.emit('log', info.id, text)
        },
      }
      const value = await work(handle)
      if (controller.signal.aborted) throw new CancelledError()
      info.status = 'done'
      info.progress = 1
      return value
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof CancelledError
      info.status = cancelled ? 'cancelled' : 'failed'
      info.error = cancelled ? null : errorMessage(error)
      if (!cancelled) record.log.append(`\n错误：${info.error}\n`)
      throw error
    } finally {
      info.endedAt = new Date().toISOString()
      this.trim()
      this.emit('change')
    }
  }

  private trim(): void {
    const finished = [...this.records.values()].filter(record => record.info.endedAt !== null)
    for (const record of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.records.delete(record.info.id)
    }
  }
}
