/** npm dist-tags published for @deepseek-ai/dsh. */
export type Channel = 'latest' | 'next' | 'alpha'
export type MirrorId = 'official' | 'npmmirror' | 'custom'
export type ProxyMode = 'system' | 'none' | 'custom'

export interface EnvVar {
  key: string
  value: string
}

export interface LaunchSettings {
  /** dsh profile to boot; the launcher only boots web-capable profiles. */
  profile: string
  port: number
  /** Pick the next free port instead of failing when the port is taken. */
  autoPort: boolean
  openBrowser: boolean
  /** Working directory of the dsh process, which dsh uses as the default workspace root. */
  workspace: string
  /** Extra app arguments appended after the launcher's own, shell-style quoting allowed. */
  extraArgs: string
  env: EnvVar[]
  /** Sets DSH_TELEMETRY_MODE=DISABLED for the dsh process. */
  disableTelemetry: boolean
}

export interface Settings {
  channel: Channel
  /** Installed dsh version used for launches; null until the first install. */
  activeVersion: string | null
  /** Version downloaded in the background, switched to on the next start. */
  pendingVersion: string | null
  autoCheck: boolean
  autoDownload: boolean
  /** Previous versions kept for rollback after an update. */
  keepVersions: number
  mirror: MirrorId
  customRegistry: string
  customNodeMirror: string
  proxyMode: ProxyMode
  proxyUrl: string
  /** Overrides DSH_HOME; empty follows $DSH_HOME, then ~/.dsh, like dsh itself. */
  dshHome: string
  closeToTray: boolean
  /** Start dsh as soon as the launcher opens. */
  autoStartDsh: boolean
  /** Register as a login item; a login start stays hidden in the tray. */
  openAtLogin: boolean
  launch: LaunchSettings
}

export type SettingsPatch = Partial<Omit<Settings, 'launch'>> & { launch?: Partial<LaunchSettings> }

export type Phase = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface ProcessStatus {
  phase: Phase
  pid: number | null
  profile: string | null
  version: string | null
  port: number | null
  url: string | null
  startedAt: string | null
  exitCode: number | null
  /** Readable reason for the last failure. */
  error: string | null
  /** Startup diagnostics file reported by dsh on a failed boot. */
  diagnostics: string | null
  /** Plugin dsh blamed for a failed boot, so the launcher can offer to disable it. */
  failedPlugin: string | null
}

export interface RuntimeStatus {
  nodeVersion: string | null
  pnpmVersion: string | null
}

export interface InstalledVersion {
  version: string
  installedAt: string | null
  dir: string
}

export interface RemoteVersion {
  version: string
  time: string | null
}

export interface RemoteInfo {
  distTags: Record<string, string>
  /** Newest first. */
  versions: RemoteVersion[]
  checkedAt: string
}

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TaskInfo {
  id: string
  title: string
  status: TaskStatus
  /** 0..1, or null while indeterminate. */
  progress: number | null
  detail: string
  error: string | null
  startedAt: string
  endedAt: string | null
}

export interface AppState {
  launcherVersion: string
  platform: string
  paths: { root: string; dshHome: string; logs: string }
  settings: Settings
  runtime: RuntimeStatus
  installed: InstalledVersion[]
  remote: RemoteInfo | null
  /** Newer version on the selected channel, if any. */
  update: string | null
  process: ProcessStatus
  tasks: TaskInfo[]
  /** Plugins or versions changed while dsh was running; a restart applies them. */
  restartRequired: boolean
  /** A newer launcher release on GitHub, if one was found. */
  launcherUpdate: LauncherRelease | null
}

export type SpecSource = 'registry' | 'git' | 'local' | 'tarball' | 'other'
export type Compat = 'ok' | 'warn' | 'unknown'

export interface PluginInfo {
  name: string
  /** Dependency spec as recorded in the profile manifest. */
  spec: string
  source: SpecSource
  /** Installed version; null when the package files are missing. */
  version: string | null
  description: string
  homepage: string | null
  /** Declares `dsh.bundle`, so it can join the profile's layer stack. */
  bundle: boolean
  /** Listed in `dsh.profile.bundles`. */
  enabled: boolean
  official: boolean
  compat: Compat
  compatNote: string | null
}

export interface BuiltinBundle {
  name: string
  description: string
  enabled: boolean
  /** Shipped switched off for the user to turn on; core bundles are not toggleable. */
  optional: boolean
}

export interface ProfileSummary {
  name: string
  exists: boolean
  shipped: boolean
  /** Includes the web app bundle, so the launcher can boot it. */
  web: boolean
  plugins: number
}

export interface ProfileDetail {
  name: string
  dir: string
  exists: boolean
  builtins: BuiltinBundle[]
  plugins: PluginInfo[]
  /** Dependencies whose build scripts pnpm blocked, awaiting approval. */
  pendingBuilds: string[]
}

export interface PluginUpdate {
  name: string
  current: string | null
  target: string
  compat: Compat
  compatNote: string | null
}

export interface PluginUpdateCheck {
  updates: PluginUpdate[]
  failures: Array<{ name: string; error: string }>
}

export type MarketSort = 'relevance' | 'downloads' | 'updated'

export interface MarketQuery {
  query: string
  sort: MarketSort
  from: number
  size?: number
  /** Keep only packages that declare `dsh.bundle`, so they actually load in dsh. */
  bundlesOnly: boolean
  /** Drop packages whose declared peer ranges exclude the running dsh. */
  hideIncompatible: boolean
}

export interface MarketItem {
  name: string
  version: string
  description: string
  keywords: string[]
  date: string | null
  publisher: string | null
  npm: string | null
  repository: string | null
  homepage: string | null
  weeklyDownloads: number | null
  official: boolean
  /** Null while the package manifest has not been read yet. */
  bundle: boolean | null
  compat: Compat
  compatNote: string | null
  deprecated: string | null
}

/** A topic derived from the indexed keywords, offered instead of a blank search box. */
export interface MarketCategory {
  label: string
  query: string
  count: number
}

/** What a direct lookup of a package-name query found, when it explains an empty result. */
export interface MarketLookup {
  name: string
  /** `missing`: npm has no such package. `not-a-plugin`: it exists but is not a dsh plugin. */
  state: 'missing' | 'not-a-plugin'
}

export interface MarketPage {
  items: MarketItem[]
  /** Packages matching the query, before per-page metadata filtering. */
  matched: number
  /** Packages in the local index. */
  indexed: number
  indexedAt: string | null
  /** Whether more pages can be requested. */
  more: boolean
  categories: MarketCategory[]
  lookup: MarketLookup | null
}

export interface PackagePreview {
  name: string
  version: string
  description: string
  license: string | null
  homepage: string | null
  bundle: boolean
  compat: Compat
  compatNote: string | null
  /** Install scripts need an explicit allowBuilds approval under pnpm 11. */
  installScripts: boolean
  deprecated: string | null
  /** The package the author renamed this plugin to, from `dsh.migrate`. */
  migrateTo: string | null
}

export type LogStream = 'stdout' | 'stderr' | 'system'

export interface LogLine {
  seq: number
  time: number
  stream: LogStream
  text: string
}

export type NoticeLevel = 'info' | 'success' | 'warning' | 'error'

export type LauncherEvent =
  | { type: 'state'; state: AppState }
  | { type: 'log'; lines: LogLine[] }
  | { type: 'task-log'; id: string; text: string }
  | { type: 'plugins-changed'; profile: string }
  | { type: 'notice'; level: NoticeLevel; message: string }

/** A launcher release published on GitHub. */
export interface LauncherRelease {
  version: string
  /** Release page, where both the installer and the portable exe are attached. */
  url: string
  publishedAt: string | null
  notes: string
}

export type CheckStatus = 'ok' | 'warn' | 'error'
/** Where the UI sends the user to fix a failed check. */
export type CheckFix = 'setup' | 'home' | 'versions' | 'plugins' | 'settings'

export interface DoctorCheck {
  id: string
  title: string
  status: CheckStatus
  detail: string
  fix: CheckFix | null
}

export interface DoctorReport {
  checkedAt: string
  launcherVersion: string
  platform: string
  checks: DoctorCheck[]
}

export interface MirrorTiming {
  mirror: MirrorId
  label: string
  registry: string
  /** Best of a few samples, in milliseconds; null when unreachable. */
  ms: number | null
  error: string | null
}

/** The file format written by "导出插件列表". */
export interface PluginExport {
  format: 'dsh-launcher-plugins'
  version: 1
  exportedAt: string
  profile: string
  dshVersion: string | null
  plugins: Array<{ name: string; spec: string; enabled: boolean }>
}

export interface ImportResult {
  requested: number
  installed: string[]
  skipped: Array<{ name: string; reason: string }>
}
