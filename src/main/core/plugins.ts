import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import semver from 'semver'
import type { Channel, PackagePreview, PluginInfo, PluginUpdate, PluginUpdateCheck, ReleaseAgeHold } from '../../shared/types'
import { assessCompat, type DshHost } from './compat'
import type { FetchFn } from './http'
import {
  fetchManifest, fetchPackument, hasInstallScripts, parsePackageSpec, repositoryUrl, resolveVersion, type VersionManifest,
} from './registry'
import { mapLimit, readJson } from './util'

export const OFFICIAL_SCOPE = '@deepseek-ai/'

export interface InstallPlan {
  /** The spec handed to `pnpm add`. */
  spec: string
  /** Pin the exact version: official packages must stay in lockstep with dsh. */
  exact: boolean
  /** Short label for task titles. */
  label: string
}

/** Group specs into as few `pnpm add` runs as possible; each run costs a full resolve. */
export function addCommands(plans: ReadonlyArray<{ spec: string; exact: boolean }>): string[][] {
  const exact = [...new Set(plans.filter(plan => plan.exact).map(plan => plan.spec))]
  const loose = [...new Set(plans.filter(plan => !plan.exact).map(plan => plan.spec))]
  const commands: string[][] = []
  if (exact.length > 0) commands.push(['add', '--save-exact', ...exact])
  if (loose.length > 0) commands.push(['add', ...loose])
  return commands
}

/**
 * Turn what the user typed into one install plan. Local folders become `link:` and local
 * tarballs `file:` so pnpm never guesses. Official `@deepseek-ai/*` packages without a version
 * are pinned to the running dsh version, because dsh publishes every package in lockstep and
 * their `latest` tag can lag far behind.
 */
export async function planInstall(fetchFn: FetchFn, registry: string, input: string, dshVersion: string | null, channel: Channel): Promise<InstallPlan> {
  const spec = input.trim()
  if (spec === '') throw new Error('请输入要安装的插件')
  if (isAbsolute(spec)) {
    const info = await stat(spec).catch(() => null)
    if (info === null) throw new Error(`找不到本地路径：${spec}`)
    return { spec: `${info.isDirectory() ? 'link' : 'file'}:${spec}`, exact: false, label: spec }
  }
  const parsed = parsePackageSpec(spec)
  if (parsed !== null && parsed.name.startsWith(OFFICIAL_SCOPE) && parsed.range === null) {
    const packument = await fetchPackument(fetchFn, registry, parsed.name)
    const version = dshVersion !== null && packument.versions[dshVersion] !== undefined
      ? dshVersion
      : packument['dist-tags'][channel] ?? packument['dist-tags'].latest
    if (version === undefined) throw new Error(`${parsed.name} 没有可用版本`)
    return { spec: `${parsed.name}@${version}`, exact: true, label: `${parsed.name}@${version}` }
  }
  return { spec, exact: false, label: spec }
}


/**
 * Registry plugins with a newer target: the running dsh version for official packages,
 * `latest` otherwise. The target's own peer ranges decide the reported compatibility, so an
 * update that would not load is visible before it is applied. Lookups that fail are reported
 * rather than silently dropped.
 */
export async function findPluginUpdates(
  fetchFn: FetchFn, registry: string, plugins: readonly PluginInfo[], host: DshHost | null, signal?: AbortSignal,
): Promise<PluginUpdateCheck> {
  const dshVersion = host?.version ?? null
  const candidates = plugins.filter(plugin => plugin.source === 'registry' && plugin.version !== null && semver.valid(plugin.version) !== null)
  const failures: PluginUpdateCheck['failures'] = []
  const results = await mapLimit(candidates, 6, async (plugin): Promise<PluginUpdate | null> => {
    try {
      const packument = await fetchPackument(fetchFn, registry, plugin.name, { signal })
      const target = plugin.official && dshVersion !== null && packument.versions[dshVersion] !== undefined
        ? dshVersion
        : packument['dist-tags'].latest
      if (target === undefined || !semver.gt(target, plugin.version!)) return null
      const { compat, note } = assessCompat(packument.versions[target]?.peerDependencies, host)
      return { name: plugin.name, current: plugin.version, target, compat, compatNote: note }
    } catch (error) {
      failures.push({ name: plugin.name, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  })
  return { updates: results.filter((update): update is PluginUpdate => update !== null), failures }
}

/** One `add` per pinning style: official packages stay exact, community ones keep pnpm's caret. */
export function planUpdates(updates: readonly PluginUpdate[]): string[][] {
  return addCommands(updates.map(update => ({ spec: `${update.name}@${update.target}`, exact: update.name.startsWith(OFFICIAL_SCOPE) })))
}

/** The folder behind a local directory spec — an absolute path, or a `link:`/`file:` one — or null. */
async function localPackageDir(spec: string): Promise<string | null> {
  const path = spec.trim().replace(/^(link|file):/i, '')
  if (!isAbsolute(path)) return null
  const info = await stat(path).catch(() => null)
  return info?.isDirectory() === true ? path : null
}

/**
 * Look a package up before installing: bundle declaration, compatibility and install scripts.
 * Registry packages come from the registry; a local plugin folder is read from disk.
 */
export async function previewPackage(
  fetchFn: FetchFn, registry: string, spec: string, host: DshHost | null, signal?: AbortSignal,
): Promise<PackagePreview> {
  const local = await localPackageDir(spec)
  if (local !== null) {
    const manifest = await readJson<VersionManifest>(join(local, 'package.json')).catch(() => null)
    if (manifest === null) throw new Error(`${local} 里没有 package.json`)
    return toPreview(manifest, host)
  }
  const parsed = parsePackageSpec(spec)
  if (parsed === null) throw new Error('只能预览 npm 包或本地插件目录（例如 dsh-cost-meter 或 @scope/name@1.2.3）')
  const dshVersion = host?.version ?? null
  const packument = await fetchPackument(fetchFn, registry, parsed.name, { signal })
  const official = parsed.name.startsWith(OFFICIAL_SCOPE)
  const version = official && parsed.range === null && dshVersion !== null && packument.versions[dshVersion] !== undefined
    ? dshVersion
    : resolveVersion(packument, parsed.range)
  if (version === null) throw new Error(`${spec} 没有匹配的版本`)
  return toPreview(await fetchManifest(fetchFn, registry, parsed.name, version, signal), host)
}

function toPreview(manifest: VersionManifest, host: DshHost | null): PackagePreview {
  const { compat, note } = assessCompat(manifest.peerDependencies, host)
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? '',
    license: manifest.license ?? null,
    homepage: manifest.homepage ?? repositoryUrl(manifest.repository),
    bundle: manifest.dsh?.bundle?.patch !== undefined,
    compat,
    compatNote: note,
    installScripts: hasInstallScripts(manifest),
    deprecated: manifest.deprecated ?? null,
    migrateTo: manifest.dsh?.migrate?.to ?? null,
  }
}

/** Same classification as dsh's plugin manager: pnpm's stable ERR_PNPM_* codes and errno names. */
const FAILURE_KINDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['pnpm 拦截了依赖的构建脚本', /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/],
  ['找不到这个包（404）', /ERR_PNPM_FETCH_404|\bE404\b|404 Not Found|Not Found - GET/],
  ['没有匹配的版本', /ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version/],
  ['磁盘空间不足', /\bENOSPC\b|no space left on device/i],
  ['文件被占用或没有权限（运行中的 dsh 可能占用了插件文件，可先停止再试）', /\bEACCES\b|\bEPERM\b|\bEBUSY\b|permission denied/i],
  ['下载的包校验失败', /ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|\bEINTEGRITY\b/],
  ['网络错误，请检查代理或切换下载源', /\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_5\d\d|ERR_PNPM_FETCH_TIMEOUT|socket hang up|Could not resolve host|unable to access/],
]

export function isBuildBlocked(output: string): boolean {
  return FAILURE_KINDS[0][1].test(output)
}

/** dsh wraps a failed run in its own line, which says nothing about what pnpm hit. */
const DSH_WRAPPER = /^dsh: pnpm failed/

/** A readable reason for a failed pnpm run, or null when nothing recognizable was printed. */
export function explainPnpmFailure(output: string): string | null {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const coded = lines.filter(line => /ERR_PNPM_[A-Z0-9_]+/.test(line)).pop() ?? null
  // pnpm prints its own diagnosis as "[ERROR] …"; prefer it over any wrapper.
  const reported = lines.map(line => /^\[ERROR\]\s*(.+)$/.exec(line)?.[1]).filter(Boolean).pop() ?? null
  const detail = coded ?? reported
  for (const [message, pattern] of FAILURE_KINDS) {
    if (pattern.test(output)) return detail === null ? message : `${message}：${detail}`
  }
  return detail ?? lines.filter(line => /error|failed/i.test(line) && !DSH_WRAPPER.test(line)).pop() ?? null
}

/** Turn a pnpm output line into a progress detail, so a long install does not look stuck. */
export function pnpmProgress(text: string): string | null {
  if (/Verifying lockfile against supply-chain policies/.test(text)) return '正在校验依赖的供应链策略（pnpm 首次运行较慢）'
  const progress = /Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/.exec(text)
  if (progress !== null) return `解析 ${progress[1]} 个依赖 · 复用 ${progress[2]} · 下载 ${progress[3]} · 写入 ${progress[4]}`
  const packages = /^Packages: (.+)$/.exec(text.trim())
  if (packages !== null) return `变更包：${packages[1]}`
  if (/Lockfile passes supply-chain policies/.test(text)) return '供应链校验通过'
  return null
}

/** pnpm 11 refuses anything published less than a day ago unless it is excluded. */
export const RELEASE_AGE_HOURS = 24

export function isReleaseAgeBlocked(output: string): boolean {
  return /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|\[MINIMUM_RELEASE_AGE_VIOLATION\]|within the minimumReleaseAge cutoff|could not be checked against minimumReleaseAge/.test(output)
}

/**
 * The entries pnpm listed, from lines like
 * `  @scope/pkg@1.2.3 was published at 2026-09-24T07:08:38.189Z, within the minimumReleaseAge cutoff (…)`
 * — strict mode puts a single new pick on the `[ERR_PNPM_NO_MATURE_MATCHING_VERSION]` line itself —
 * or, when a mirror has not synced the publish time yet,
 * `  pkg@1.2.3 could not be checked against minimumReleaseAge (version not present in registry manifest)`.
 * pnpm prints at most 20; the rest surface on the next attempt. Only exact semver versions come
 * back, because pnpm rejects anything else in `minimumReleaseAgeExclude` on every later run.
 */
export function parseReleaseAgeHolds(output: string): ReleaseAgeHold[] {
  const pattern = /^\s*(?:\[?ERR_PNPM_[A-Z_]+\]?:?\s+)?(@[^\s/@]+\/[^\s@]+|[^\s@[\]]+)@(\S+) (?:\[(?:ERR_PNPM_)?MINIMUM_RELEASE_AGE_VIOLATION\] )?(?:was published at (\S+), within the minimumReleaseAge cutoff|could not be checked against minimumReleaseAge|publish timestamp is not a valid date)/gm
  const holds = new Map<string, ReleaseAgeHold>()
  for (const match of output.matchAll(pattern)) {
    if (semver.valid(match[2]) !== match[2]) continue
    holds.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2], publishedAt: match[3] ?? null })
  }
  return [...holds.values()]
}

/**
 * The window pnpm applied, read back from the cutoff it printed — the output comes straight from
 * the run, so `now` stands in for when pnpm computed it. pnpm's default when there is no cutoff.
 */
export function releaseAgeWindowHours(output: string, now = Date.now()): number {
  const cutoff = /within the minimumReleaseAge cutoff \(([^)\s]+)\)/.exec(output)
  const time = cutoff === null ? Number.NaN : Date.parse(cutoff[1])
  return Number.isNaN(time) ? RELEASE_AGE_HOURS : Math.max(1, Math.round((now - time) / 3_600_000))
}

/** "24 小时", or whole days once the window runs past two of them. */
export function formatReleaseAgeWindow(hours: number): string {
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`
}

/** Whole hours until the newest held version clears the window, or null when any time is unknown. */
export function hoursUntilCleared(holds: readonly ReleaseAgeHold[], now = Date.now(), windowHours = RELEASE_AGE_HOURS): number | null {
  const times = holds.map(hold => Date.parse(hold.publishedAt ?? '')).filter(time => !Number.isNaN(time))
  if (times.length === 0 || times.length < holds.length) return null
  return Math.max(0, Math.ceil((Math.max(...times) + windowHours * 3_600_000 - now) / 3_600_000))
}
