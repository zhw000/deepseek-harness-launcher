import { homedir } from 'node:os'
import { join } from 'node:path'

export interface LauncherPaths {
  root: string
  settings: string
  /** Managed Node.js runtimes, one `v<version>` folder each. */
  node: string
  /** Private pnpm install used by `dsh plugin`. */
  pnpm: string
  /** Shims (pnpm) and the shutdown bridge. */
  bin: string
  /** Installed dsh versions, one folder per version. */
  versions: string
  downloads: string
  logs: string
  /** Plugin index and package metadata caches. */
  cache: string
}

export function launcherPaths(root: string): LauncherPaths {
  return {
    root,
    settings: join(root, 'settings.json'),
    node: join(root, 'node'),
    pnpm: join(root, 'pnpm'),
    bin: join(root, 'bin'),
    versions: join(root, 'versions'),
    downloads: join(root, 'downloads'),
    logs: join(root, 'logs'),
    cache: join(root, 'cache'),
  }
}

/**
 * Where runtimes and dsh versions live. Big binaries stay out of roaming profiles:
 * %LOCALAPPDATA% on Windows, Application Support on macOS, XDG data home elsewhere.
 */
export function defaultDataRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home = homedir()): string {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'dsh-launcher')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'dsh-launcher')
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'dsh-launcher')
}

export function expandHome(path: string, home = homedir()): string {
  if (path === '~') return home
  if (/^~[/\x5c]/.test(path)) return join(home, path.slice(2))
  return path
}

/** Same precedence as dsh: explicit setting, then non-blank $DSH_HOME, then ~/.dsh. */
export function resolveDshHome(configured: string, env: NodeJS.ProcessEnv, home = homedir()): string {
  if (configured.trim() !== '') return expandHome(configured.trim(), home)
  const fromEnv = env.DSH_HOME?.trim()
  if (fromEnv) return expandHome(fromEnv, home)
  return join(home, '.dsh')
}

export function profilesDir(dshHome: string): string {
  return join(dshHome, 'profiles')
}

export function profileDir(dshHome: string, name: string): string {
  assertProfileName(name)
  return join(profilesDir(dshHome), name)
}

/** Existing shipped profiles are allowed, filesystem traversal and Windows aliases are not. */
export function assertProfileName(name: string): void {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    || ['desktop', 'node_modules', 'plugin'].includes(name.toLowerCase())) {
    throw new Error('无效的配置名称')
  }
}
