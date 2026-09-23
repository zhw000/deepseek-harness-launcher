import type {
  AppState, LauncherEvent, LogLine, MarketPage, PackagePreview, PluginUpdate,
  ProfileDetail, ProfileSummary, SettingsPatch, PluginUpdateCheck, MarketQuery,
} from './types'

export type OpenTarget = 'root' | 'dshHome' | 'dshLogs' | 'logs' | 'workspace' | 'profile'

/** Everything the renderer can ask of the main process. */
export interface LauncherApi {
  getState(): Promise<AppState>
  getLogs(): Promise<LogLine[]>
  clearLogs(): Promise<void>
  getTaskLog(id: string): Promise<string>

  /** Download whatever is missing: Node.js, pnpm and the channel's dsh version. */
  setup(): Promise<void>
  checkUpdates(): Promise<void>
  installVersion(version: string, activate: boolean): Promise<void>
  activateVersion(version: string): Promise<void>
  removeVersion(version: string): Promise<void>
  getReleaseNotes(version: string): Promise<string | null>

  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  openWebUI(): Promise<void>

  listProfiles(): Promise<ProfileSummary[]>
  createProfile(name: string): Promise<void>
  getProfile(name: string): Promise<ProfileDetail>
  checkPluginUpdates(profile: string): Promise<PluginUpdateCheck>
  installPlugin(profile: string, spec: string): Promise<void>
  removePlugin(profile: string, name: string): Promise<void>
  updatePlugins(profile: string, updates: PluginUpdate[]): Promise<void>
  setBundleEnabled(profile: string, name: string, enabled: boolean): Promise<void>
  /** Allow or decline the build scripts pnpm blocked; either decision unblocks later installs. */
  decideBuilds(profile: string, names: string[], allow: boolean): Promise<void>

  searchMarket(query: MarketQuery): Promise<MarketPage>
  /** Rebuild the local plugin index from the registry. */
  refreshMarketIndex(): Promise<void>
  previewPackage(spec: string): Promise<PackagePreview>

  updateSettings(patch: SettingsPatch): Promise<void>
  cancelTask(id: string): Promise<void>
  pickDirectory(initial?: string): Promise<string | null>
  pickFile(): Promise<string | null>
  openPath(target: OpenTarget, profile?: string): Promise<void>
  openExternal(url: string): Promise<void>
}

export type LauncherMethod = keyof LauncherApi

/** Methods the preload bridge forwards; the main process accepts no others. */
export const API_METHODS = [
  'getState', 'getLogs', 'clearLogs', 'getTaskLog',
  'setup', 'checkUpdates', 'installVersion', 'activateVersion', 'removeVersion', 'getReleaseNotes',
  'start', 'stop', 'restart', 'openWebUI',
  'listProfiles', 'createProfile', 'getProfile', 'checkPluginUpdates', 'installPlugin', 'removePlugin',
  'updatePlugins', 'setBundleEnabled', 'decideBuilds',
  'searchMarket', 'refreshMarketIndex', 'previewPackage',
  'updateSettings', 'cancelTask', 'pickDirectory', 'pickFile', 'openPath', 'openExternal',
] as const satisfies readonly LauncherMethod[]

/** The object the preload script exposes as `window.launcher`. */
export interface LauncherBridge extends LauncherApi {
  subscribe(listener: (event: LauncherEvent) => void): () => void
}

export const INVOKE_CHANNEL = 'launcher:invoke'
export const EVENT_CHANNEL = 'launcher:event'

export type InvokeResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string }
