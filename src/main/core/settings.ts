import { join } from 'node:path'
import type { Channel, EnvVar, LaunchSettings, MirrorId, ProxyMode, Settings, SettingsPatch } from '../../shared/types'
import { readJson, writeJsonAtomic } from './util'

/** Encrypts environment values at rest (Electron safeStorage in the app). */
export interface SecretCodec {
  encrypt(plain: string): string
  decrypt(stored: string): string
}

const CHANNELS: Channel[] = ['latest', 'next', 'alpha']
const MIRRORS: MirrorId[] = ['official', 'npmmirror', 'custom']
const PROXY_MODES: ProxyMode[] = ['system', 'none', 'custom']
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_PREFIX = 'enc:'

export function defaultSettings(home: string, locale = 'en'): Settings {
  return {
    channel: 'latest',
    activeVersion: null,
    pendingVersion: null,
    autoCheck: true,
    autoDownload: false,
    keepVersions: 2,
    // npmmirror is much faster from mainland China; it syncs npm within minutes.
    mirror: locale.toLowerCase().startsWith('zh') ? 'npmmirror' : 'official',
    customRegistry: '',
    customNodeMirror: '',
    proxyMode: 'system',
    proxyUrl: '',
    dshHome: '',
    closeToTray: true,
    autoStartDsh: false,
    openAtLogin: false,
    launch: {
      profile: 'web',
      port: 3080,
      autoPort: true,
      openBrowser: true,
      workspace: join(home, 'dsh-workspace'),
      extraArgs: '',
      env: [],
      disableTelemetry: false,
    },
  }
}

type Raw = Record<string, unknown>

const asRecord = (value: unknown): Raw => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Raw : {})
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? value as T : fallback)
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const nullableText = (value: unknown, fallback: string | null): string | null => (typeof value === 'string' || value === null ? value : fallback)
const int = (value: unknown, min: number, max: number, fallback: number): number =>
  (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback)

function envList(value: unknown, fallback: EnvVar[]): EnvVar[] {
  if (!Array.isArray(value)) return fallback
  return value
    .map(asRecord)
    .filter(entry => typeof entry.key === 'string' && ENV_KEY.test(entry.key) && typeof entry.value === 'string')
    .map(entry => ({ key: entry.key as string, value: entry.value as string }))
}

/** Coerce anything read from disk or sent by the renderer into valid settings. */
export function normalizeSettings(input: unknown, defaults: Settings): Settings {
  const raw = asRecord(input)
  const launch = asRecord(raw.launch)
  const d = defaults.launch
  const normalizedLaunch: LaunchSettings = {
    profile: text(launch.profile, d.profile).trim() || d.profile,
    port: int(launch.port, 1, 65535, d.port),
    autoPort: bool(launch.autoPort, d.autoPort),
    openBrowser: bool(launch.openBrowser, d.openBrowser),
    workspace: text(launch.workspace, d.workspace).trim() || d.workspace,
    extraArgs: text(launch.extraArgs, d.extraArgs),
    env: envList(launch.env, d.env),
    disableTelemetry: bool(launch.disableTelemetry, d.disableTelemetry),
  }
  return {
    channel: oneOf(raw.channel, CHANNELS, defaults.channel),
    activeVersion: nullableText(raw.activeVersion, defaults.activeVersion),
    pendingVersion: nullableText(raw.pendingVersion, defaults.pendingVersion),
    autoCheck: bool(raw.autoCheck, defaults.autoCheck),
    autoDownload: bool(raw.autoDownload, defaults.autoDownload),
    keepVersions: int(raw.keepVersions, 0, 10, defaults.keepVersions),
    mirror: oneOf(raw.mirror, MIRRORS, defaults.mirror),
    customRegistry: text(raw.customRegistry, defaults.customRegistry).trim(),
    customNodeMirror: text(raw.customNodeMirror, defaults.customNodeMirror).trim(),
    proxyMode: oneOf(raw.proxyMode, PROXY_MODES, defaults.proxyMode),
    proxyUrl: text(raw.proxyUrl, defaults.proxyUrl).trim(),
    dshHome: text(raw.dshHome, defaults.dshHome).trim(),
    closeToTray: bool(raw.closeToTray, defaults.closeToTray),
    autoStartDsh: bool(raw.autoStartDsh, defaults.autoStartDsh),
    openAtLogin: bool(raw.openAtLogin, defaults.openAtLogin),
    launch: normalizedLaunch,
  }
}

export function applySettingsPatch(current: Settings, patch: SettingsPatch, defaults: Settings): Settings {
  return normalizeSettings({ ...current, ...patch, launch: { ...current.launch, ...patch.launch } }, defaults)
}

function decodeSecret(value: string, codec: SecretCodec | undefined): string {
  if (!value.startsWith(SECRET_PREFIX)) return value
  if (codec === undefined) return ''
  try {
    return codec.decrypt(value.slice(SECRET_PREFIX.length))
  } catch {
    // Encrypted on another machine or account; the value cannot be recovered.
    return ''
  }
}

export async function loadSettings(file: string, defaults: Settings, codec?: SecretCodec): Promise<Settings> {
  const raw = await readJson<unknown>(file).catch(() => null)
  const settings = normalizeSettings(raw, defaults)
  settings.launch.env = settings.launch.env.map(entry => ({ ...entry, value: decodeSecret(entry.value, codec) }))
  return settings
}

export async function saveSettings(file: string, settings: Settings, codec?: SecretCodec): Promise<void> {
  const env = settings.launch.env.map(entry => ({
    ...entry,
    value: codec === undefined || entry.value === '' ? entry.value : SECRET_PREFIX + codec.encrypt(entry.value),
  }))
  await writeJsonAtomic(file, { ...settings, launch: { ...settings.launch, env } })
}
