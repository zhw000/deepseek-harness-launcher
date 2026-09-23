import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, EVENT_CHANNEL, INVOKE_CHANNEL, type InvokeResult, type LauncherBridge } from '../shared/api'
import type { LauncherEvent } from '../shared/types'

const bridge: Record<string, unknown> = {}

for (const method of API_METHODS) {
  bridge[method] = async (...args: unknown[]) => {
    const result = await ipcRenderer.invoke(INVOKE_CHANNEL, method, args) as InvokeResult
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
}

bridge.subscribe = (listener: (event: LauncherEvent) => void) => {
  const handler = (_: Electron.IpcRendererEvent, event: LauncherEvent) => listener(event)
  ipcRenderer.on(EVENT_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(EVENT_CHANNEL, handler)
  }
}

contextBridge.exposeInMainWorld('launcher', bridge as unknown as LauncherBridge)
