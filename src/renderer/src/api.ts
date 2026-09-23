import type { LauncherBridge } from '../../shared/api'
import { createMockBridge } from './mock'

declare global {
  interface Window {
    launcher?: LauncherBridge
  }
}

/** True in a plain browser (`npm run dev:web`), where a simulated backend stands in for Electron. */
export const isMock = window.launcher === undefined

export const api: LauncherBridge = window.launcher ?? createMockBridge()
