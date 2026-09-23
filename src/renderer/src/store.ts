import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { AppState, LauncherEvent, LogLine, NoticeLevel } from '../../shared/types'
import { api } from './api'

export interface Notice {
  id: number
  level: NoticeLevel
  message: string
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

const MAX_LOG_LINES = 5000
const MAX_TASK_LOG = 200_000

/** Everything pushed from the main process, plus UI-only notices and confirmations. */
class LauncherStore {
  state: AppState | null = null
  logs: LogLine[] = []
  notices: Notice[] = []
  confirm: ConfirmRequest | null = null
  /** Bumped whenever a profile's plugins change, so plugin views refetch. */
  pluginsRevision = 0
  taskLogRevision = 0
  private readonly taskLogs = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private noticeId = 0
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    api.subscribe(event => this.handle(event))
    void api.getState().then((state) => {
      this.state = state
      this.emit()
    })
    void api.getLogs().then((lines) => {
      this.logs = lines
      this.emit()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  taskLog(id: string): string | undefined {
    return this.taskLogs.get(id)
  }

  seedTaskLog(id: string, text: string): void {
    if (!this.taskLogs.has(id)) {
      this.taskLogs.set(id, text)
      this.taskLogRevision++
      this.emit()
    }
  }

  notify(level: NoticeLevel, message: string): void {
    const id = ++this.noticeId
    this.notices = [...this.notices, { id, level, message }].slice(-4)
    this.emit()
    setTimeout(() => this.dismiss(id), level === 'error' ? 9000 : 4500)
  }

  dismiss(id: number): void {
    this.notices = this.notices.filter(notice => notice.id !== id)
    this.emit()
  }

  clearLogs(): void {
    this.logs = []
    this.emit()
  }

  ask(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
    // Only one dialog at a time: a newer question cancels an unanswered one.
    this.confirm?.resolve(false)
    return new Promise((resolve) => {
      this.confirm = {
        ...request,
        resolve: (ok) => {
          this.confirm = null
          this.emit()
          resolve(ok)
        },
      }
      this.emit()
    })
  }

  private handle(event: LauncherEvent): void {
    switch (event.type) {
      case 'state':
        this.state = event.state
        break
      case 'log':
        this.logs = [...this.logs, ...event.lines].slice(-MAX_LOG_LINES)
        break
      case 'task-log': {
        const next = (this.taskLogs.get(event.id) ?? '') + event.text
        this.taskLogs.set(event.id, next.length > MAX_TASK_LOG ? next.slice(-MAX_TASK_LOG) : next)
        this.taskLogRevision++
        break
      }
      case 'plugins-changed':
        this.pluginsRevision++
        break
      case 'notice':
        this.notify(event.level, event.message)
        return
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const store = new LauncherStore()

export function useStore<T>(select: (store: LauncherStore) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store))
}

export function useAppState(): AppState {
  const state = useStore(current => current.state)
  if (state === null) throw new Error('state not loaded')
  return state
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run an action, turning failures into error toasts. */
export async function attempt<T>(work: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const value = await work()
    if (success) store.notify('success', success)
    return value
  } catch (error) {
    const message = messageOf(error)
    store.notify(message === '已取消' ? 'info' : 'error', message)
    return undefined
  }
}

/** A busy flag around `attempt`, for buttons. */
export function useAction(): [boolean, <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async <T,>(work: () => Promise<T>, success?: string) => {
    setBusy(true)
    try {
      return await attempt(work, success)
    } finally {
      setBusy(false)
    }
  }, [])
  return [busy, run]
}

export type Route = 'home' | 'versions' | 'plugins' | 'market' | 'settings'
const ROUTES: Route[] = ['home', 'versions', 'plugins', 'market', 'settings']

function readRoute(): Route {
  const name = window.location.hash.replace(/^#\/?/, '')
  return ROUTES.includes(name as Route) ? name as Route : 'home'
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const onChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const go = useCallback((next: Route) => {
    window.location.hash = `#/${next}`
  }, [])
  return [route, go]
}

export const navigate = (route: Route) => {
  window.location.hash = `#/${route}`
}
