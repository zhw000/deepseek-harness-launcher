import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml'
import type { BuiltinBundle, PluginCompatIssue, PluginInfo, ProfileDetail, ProfileSummary, SpecSource } from '../../shared/types'
import { assessCompat, suggestDsh, type DshHost } from './compat'
import { dshPackageDir } from './dsh-versions'
import { profileDir, profilesDir } from './paths'
import { repositoryUrl, type VersionManifest } from './registry'
import { mapLimit, readJson, sleep, writeFileAtomic } from './util'

/** Bundles that make up the shipped apps; they are not user-toggleable. */
export const CORE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-acp-app',
]
export const WEB_BUNDLE = '@deepseek-ai/dsh-web-app'
/** App bundles whose command line is not the web server's. */
const NON_WEB_APPS = CORE_BUNDLES.filter(name => name !== WEB_BUNDLE && name !== '@deepseek-ai/dsh-base')
export const SHIPPED_PROFILES = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp']
const SHIPPED_BUNDLES: Record<string, string[]> = {
  web: ['@deepseek-ai/dsh-base', WEB_BUNDLE],
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
  'sdk-minimal': ['@deepseek-ai/dsh-sdk-minimal'],
  acp: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
}
/** `desktop` belongs to DeepSeek's Electron app; `node_modules` is dsh's module fallback. */
const HIDDEN_ENTRIES = new Set(['desktop', 'node_modules'])
/** Value pnpm 11 writes under allowBuilds for a dependency awaiting a decision. */
const PENDING_BUILD = 'set this to true or false'

export interface ProfileManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; bundle?: { patch?: string } }
  [key: string]: unknown
}

export function readProfileManifest(dir: string): Promise<ProfileManifest | null> {
  return readJson<ProfileManifest>(join(dir, 'package.json'))
}

export function validateProfileName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return '名称只能包含字母、数字、点、下划线和连字符，并以字母或数字开头'
  const lower = name.toLowerCase()
  if (SHIPPED_PROFILES.includes(lower)) return `“${name}” 是 dsh 内置配置的名称`
  if (lower === 'desktop') return '“desktop” 保留给 DeepSeek 官方桌面端'
  if (lower === 'plugin' || lower === 'node_modules') return `“${name}” 是保留名称`
  return null
}

export function isWebProfile(bundles: readonly string[]): boolean {
  return bundles.includes(WEB_BUNDLE) && !bundles.some(name => NON_WEB_APPS.includes(name))
}

/** Profiles under $DSH_HOME/profiles plus the shipped `web` profile, which dsh creates on first use. */
export async function listProfiles(dshHome: string): Promise<ProfileSummary[]> {
  const names = new Set<string>(['web'])
  try {
    for (const entry of await readdir(profilesDir(dshHome), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !HIDDEN_ENTRIES.has(entry.name.toLowerCase())) names.add(entry.name)
    }
  } catch {
    // No profiles yet.
  }
  const summaries: ProfileSummary[] = []
  for (const name of names) {
    const manifest = await readProfileManifest(profileDir(dshHome, name)).catch(() => null)
    const shipped = SHIPPED_PROFILES.includes(name)
    if (manifest?.dsh?.profile === undefined && !(shipped && manifest === null)) continue
    const bundles = manifest?.dsh?.profile?.bundles ?? SHIPPED_BUNDLES[name] ?? []
    summaries.push({
      name,
      exists: manifest !== null,
      shipped,
      web: isWebProfile(bundles),
      plugins: Object.keys(manifest?.dependencies ?? {}).length,
    })
  }
  const rank = (profile: ProfileSummary) => (profile.name === 'web' ? 0 : profile.shipped ? 2 : 1)
  return summaries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const pid = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) return Date.now() - (await stat(lockPath)).mtimeMs > 60_000
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Hold the profile manifest writer lock dsh itself uses: a `wx`-created
 * `package.json.lock` holding the owner's pid. A lock left by a dead process is taken over.
 */
export async function withProfileLock<T>(dir: string, work: () => Promise<T>, waitMs = 60_000): Promise<T> {
  const lockPath = join(dir, 'package.json.lock')
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await lockIsStale(lockPath)) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`配置正被其他进程修改，请稍后再试（${lockPath}）`)
      await sleep(200)
    }
  }
  try {
    return await work()
  } finally {
    await rm(lockPath, { force: true })
  }
}

/**
 * Enable or disable a bundle by editing `dsh.profile.bundles`, the same way dsh's
 * plugin manager does: disabling keeps the dependency installed, enabling appends
 * the bundle last. Returns whether the manifest changed.
 */
export function setBundleEnabled(dir: string, name: string, enabled: boolean): Promise<boolean> {
  return withProfileLock(dir, async () => {
    const manifest = await readProfileManifest(dir)
    if (manifest?.dsh?.profile === undefined) throw new Error('配置清单缺少 dsh.profile')
    const bundles = manifest.dsh.profile.bundles ?? []
    if (bundles.includes(name) === enabled) return false
    const next = enabled ? [...bundles, name] : bundles.filter(bundle => bundle !== name)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: next } }
    await writeFileAtomic(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
    return true
  })
}

async function readWorkspacePolicy(dir: string): Promise<{ document: Document; pending: string[] } | null> {
  let text: string
  try {
    text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const document = parseDocument(text)
  if (document.errors.length > 0) throw document.errors[0]
  const builds = document.get('allowBuilds')
  const pending = isMap(builds)
    ? builds.items.flatMap(({ key, value }) => (isScalar(key) && typeof key.value === 'string' && !/[*?]/.test(key.value)
      && isScalar(value) && value.value === PENDING_BUILD ? [key.value] : []))
    : []
  return { document, pending }
}

/** Dependencies whose build scripts pnpm 11 blocked and recorded as undecided. */
export async function readPendingBuilds(dir: string): Promise<string[]> {
  return (await readWorkspacePolicy(dir).catch(() => null))?.pending ?? []
}
/**
 * Record a decision for the named pending builds. pnpm 11 fails every install in the profile
 * while any dependency is undecided, so declining (`false`) is a real escape hatch: it unblocks
 * installs without ever running those scripts.
 */
export function decideBuilds(dir: string, names: readonly string[], allow: boolean): Promise<void> {
  return withProfileLock(dir, async () => {
    const policy = await readWorkspacePolicy(dir)
    if (policy === null) throw new Error('配置目录中没有 pnpm-workspace.yaml')
    const stale = names.filter(name => !policy.pending.includes(name))
    if (stale.length > 0) throw new Error(`这些依赖已不在待批准列表中：${stale.join(', ')}`)
    for (const name of names) policy.document.setIn(['allowBuilds', name], allow)
    await writeFileAtomic(join(dir, 'pnpm-workspace.yaml'), String(policy.document))
  })
}

/**
 * Trust exact versions pnpm held back for being too new, by adding `name@version` to
 * `minimumReleaseAgeExclude` — the same entries pnpm writes itself in its default mode.
 * Only those versions are exempt; later releases still wait out the window.
 */
export function trustReleaseAge(dir: string, holds: ReadonlyArray<{ name: string; version: string }>): Promise<number> {
  return withProfileLock(dir, async () => {
    const path = join(dir, 'pnpm-workspace.yaml')
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      throw new Error('配置目录中没有 pnpm-workspace.yaml')
    }
    const document = parseDocument(text)
    if (document.errors.length > 0) throw document.errors[0]
    const current = document.get('minimumReleaseAgeExclude')
    if (current !== undefined && !isSeq(current)) throw new Error('minimumReleaseAgeExclude 必须是列表')
    const existing = isSeq(current) ? current.items.map(item => (isScalar(item) ? String(item.value) : '')) : []
    const additions = [...new Set(holds
      .filter(hold => !existing.some(entry => excludeCovers(entry, hold.name, hold.version)))
      .map(hold => `${hold.name}@${hold.version}`))]
    if (additions.length === 0) return 0
    if (isSeq(current)) {
      for (const entry of additions) current.add(document.createNode(entry))
    } else {
      document.set('minimumReleaseAgeExclude', document.createNode(additions))
    }
    await writeFileAtomic(path, String(document))
    return additions.length
  })
}

/** Whether an exclude entry — a bare name or `name@1.0.0 || 1.0.1` — already covers this version. */
function excludeCovers(entry: string, name: string, version: string): boolean {
  // Negations and globs are left to pnpm; an extra exact entry next to them is harmless.
  if (entry.startsWith('!') || entry.includes('*')) return false
  const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@')
  if (at === -1) return entry === name
  return entry.slice(0, at) === name && entry.slice(at + 1).split('||').some(item => item.trim() === version)
}

/**
 * Whether pnpm wants a person to approve too-new versions in this profile. Out of the box pnpm
 * trusts them itself and records them in `minimumReleaseAgeExclude`; `minimumReleaseAgeStrict`,
 * which setting `minimumReleaseAge` explicitly also switches on, makes it ask instead.
 */
export async function releaseAgeStrict(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const settings = new Map<string, unknown>()
  for (const [key, value] of Object.entries(env)) {
    const match = /^pnpm_config_minimum_release_age(_strict)?$/i.exec(key)
    if (match !== null && value !== undefined && value !== '') settings.set(match[1] === undefined ? 'age' : 'strict', value)
  }
  const text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8').catch(() => '')
  const config: unknown = parseDocument(text).toJS()
  if (config !== null && typeof config === 'object') {
    const record = config as Record<string, unknown>
    if (record.minimumReleaseAge != null) settings.set('age', record.minimumReleaseAge)
    if (record.minimumReleaseAgeStrict != null) settings.set('strict', record.minimumReleaseAgeStrict)
  }
  const strict = settings.get('strict')
  if (strict !== undefined) return strict === true || String(strict).toLowerCase() === 'true'
  return settings.has('age')
}

export function classifySpec(spec: string): SpecSource {
  const value = spec.trim()
  if (/^(link|file):/i.test(value)) return /\.(tgz|tar\.gz)$/i.test(value) ? 'tarball' : 'local'
  if (/^(github|gitlab|bitbucket):|^git(\+[a-z]+)?:\/\/|^git\+|\.git(#.*)?$/i.test(value)) return 'git'
  if (/^https?:\/\//i.test(value)) return /\.(tgz|tar\.gz)(\?.*)?$/i.test(value) ? 'tarball' : 'other'
  if (value.startsWith('npm:') || value.startsWith('workspace:')) return 'other'
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(value)) return 'git'
  if (value === '' || value === '*' || value === 'latest' || semver.validRange(value) !== null || /^[a-z][\w.-]*$/i.test(value)) return 'registry'
  return 'other'
}

export interface InstallationBundle {
  name: string
  description: string
}

/** Bundles the dsh installation ships: its dependencies that declare `dsh.bundle`. */
export async function installationBundles(versionDir: string): Promise<InstallationBundle[]> {
  const cli = await readJson<VersionManifest>(join(dshPackageDir(versionDir), 'package.json'))
  const bundles: InstallationBundle[] = []
  for (const name of Object.keys(cli?.dependencies ?? {})) {
    const parts = name.split('/')
    const manifest = await readJson<VersionManifest>(join(versionDir, 'node_modules', ...parts, 'package.json')).catch(() => null)
      ?? await readJson<VersionManifest>(join(dshPackageDir(versionDir), 'node_modules', ...parts, 'package.json')).catch(() => null)
    if (manifest?.dsh?.bundle?.patch !== undefined) bundles.push({ name, description: manifest.description ?? '' })
  }
  return bundles
}

/**
 * The `@deepseek-ai/*` packages a dsh installation ships, name → version. Plugins resolve these
 * peers from dsh at runtime, so their ranges are checked against these copies.
 */
export async function installationPackages(versionDir: string): Promise<Map<string, string>> {
  const packages = new Map<string, string>()
  for (const scope of [join(versionDir, 'node_modules', '@deepseek-ai'), join(dshPackageDir(versionDir), 'node_modules', '@deepseek-ai')]) {
    const entries = await readdir(scope).catch(() => [] as string[])
    const manifests = await mapLimit(entries, 16, entry => readJson<VersionManifest>(join(scope, entry, 'package.json')).catch(() => null))
    for (const found of manifests) {
      if (found?.name !== undefined && found.version !== undefined && !packages.has(found.name)) packages.set(found.name, found.version)
    }
  }
  return packages
}

export interface DetailContext {
  host: DshHost | null
  installation: readonly InstallationBundle[]
  /** Published dsh versions, newest first, and their dist-tags: where to look for one the plugins accept. */
  published?: { versions: readonly string[]; tags: Readonly<Record<string, string>> }
}

function installedManifest(dir: string, name: string): Promise<VersionManifest | null> {
  return readJson<VersionManifest>(join(dir, 'node_modules', ...name.split('/'), 'package.json')).catch(() => null)
}

/** Plugins of a profile whose declared ranges reject `host`, phrased for "after switching to it". */
export async function profileCompatIssues(dshHome: string, name: string, host: DshHost): Promise<PluginCompatIssue[]> {
  const dir = profileDir(dshHome, name)
  const names = Object.keys((await readProfileManifest(dir))?.dependencies ?? {})
  const issues = await mapLimit(names, 8, async (pkg) => {
    const { compat, needs } = assessCompat((await installedManifest(dir, pkg))?.peerDependencies, host)
    return compat === 'warn' ? { name: pkg, note: needs.join('；') } : null
  })
  return issues.filter((issue): issue is PluginCompatIssue => issue !== null)
}

export async function readProfileDetail(dshHome: string, name: string, context: DetailContext): Promise<ProfileDetail> {
  const dir = profileDir(dshHome, name)
  const manifest = await readProfileManifest(dir)
  const bundles = manifest?.dsh?.profile?.bundles ?? SHIPPED_BUNDLES[name] ?? []
  const assessed = await mapLimit(Object.entries(manifest?.dependencies ?? {}), 8, async ([pkg, spec]) => {
    const installed = await installedManifest(dir, pkg)
    const { compat, note, dshRanges } = assessCompat(installed?.peerDependencies, context.host)
    const plugin: PluginInfo = {
      name: pkg,
      spec,
      source: classifySpec(spec),
      version: installed?.version ?? null,
      description: installed?.description ?? '',
      homepage: installed?.homepage ?? repositoryUrl(installed?.repository),
      bundle: installed?.dsh?.bundle?.patch !== undefined,
      enabled: bundles.includes(pkg),
      official: pkg.startsWith('@deepseek-ai/'),
      compat,
      compatNote: note,
      removing: false,
    }
    return { plugin, dshRanges }
  })
  const plugins = assessed.map(item => item.plugin)
  const current = context.host?.version
  const rejected = current !== undefined
    && assessed.some(item => item.dshRanges.some(range => !semver.satisfies(current, range, { includePrerelease: true })))
  const builtins: BuiltinBundle[] = []
  for (const bundle of context.installation) {
    const optional = !CORE_BUNDLES.includes(bundle.name)
    const enabled = bundles.includes(bundle.name)
    if (optional || enabled) builtins.push({ name: bundle.name, description: bundle.description, enabled, optional })
  }
  for (const bundle of bundles) {
    const known = builtins.some(item => item.name === bundle) || plugins.some(plugin => plugin.name === bundle)
    if (!known) builtins.push({ name: bundle, description: '', enabled: true, optional: false })
  }
  return {
    name,
    dir,
    exists: manifest !== null,
    builtins,
    plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
    pendingBuilds: manifest === null ? [] : await readPendingBuilds(dir),
    releaseAgeHolds: [],
    dshSuggestion: current !== undefined && rejected && context.published !== undefined
      ? suggestDsh(assessed.map(item => item.dshRanges), context.published.versions, context.published.tags, current)
      : null,
  }
}
