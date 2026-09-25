import semver, { type SemVer } from 'semver'
import type { Compat, DshSuggestion } from '../../shared/types'

/** What a dsh installation gives its plugins: its own version and the `@deepseek-ai/*` packages it ships. */
export interface DshHost {
  version: string
  /** name → version; empty when the installation was not read, e.g. for a version not installed yet. */
  packages: ReadonlyMap<string, string>
}

export interface CompatResult {
  compat: Compat
  /** One sentence per problem, e.g. "需要 dsh ≥ 0.1.7-rc.1，当前是 0.1.5-rc.3". */
  note: string | null
  /** The same problems without naming the host's version — for "after switching to it". */
  needs: string[]
  /** The ranges the plugin sets on dsh itself, through its `@deepseek-ai/dsh*` peers. */
  dshRanges: string[]
}

const OPTIONS = { includePrerelease: true }
const OFFICIAL = '@deepseek-ai/'

export function versionHost(version: string): DshHost {
  return { version, packages: new Map() }
}

/**
 * `@deepseek-ai/dsh` and every `@deepseek-ai/dsh-*` package move in lockstep with dsh, and some
 * of them (`dsh-client-runtime`) exist only inside the running web app. Either way a plugin's
 * range on one of them is a range on the dsh version.
 */
export function isLockstep(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

interface Bound {
  version: SemVer
  inclusive: boolean
}

/** Stricter of two lower bounds; null is unbounded. */
function maxLower(a: Bound | null, b: Bound | null): Bound | null {
  if (a === null) return b
  if (b === null) return a
  const order = semver.compare(a.version, b.version)
  if (order !== 0) return order > 0 ? a : b
  return a.inclusive ? b : a
}

/** Stricter of two upper bounds; null is unbounded. */
function minUpper(a: Bound | null, b: Bound | null): Bound | null {
  if (a === null) return b
  if (b === null) return a
  const order = semver.compare(a.version, b.version)
  if (order !== 0) return order < 0 ? a : b
  return a.inclusive ? b : a
}

/** Looser of two lower bounds, for `||`: an unbounded side stays unbounded. */
function minLower(a: Bound | null, b: Bound | null): Bound | null {
  if (a === null || b === null) return null
  const order = semver.compare(a.version, b.version)
  if (order !== 0) return order < 0 ? a : b
  return a.inclusive ? a : b
}

/** Looser of two upper bounds, for `||`. */
function maxUpper(a: Bound | null, b: Bound | null): Bound | null {
  if (a === null || b === null) return null
  const order = semver.compare(a.version, b.version)
  if (order !== 0) return order > 0 ? a : b
  return a.inclusive ? a : b
}

/** The lowest and highest versions a range admits across all of its `||` alternatives. */
function rangeBounds(range: string): { lower: Bound | null; upper: Bound | null } {
  let lower: Bound | null | undefined
  let upper: Bound | null | undefined
  for (const set of new semver.Range(range, OPTIONS).set) {
    let setLower: Bound | null = null
    let setUpper: Bound | null = null
    for (const comparator of set) {
      if (comparator.value === '') continue
      const { operator } = comparator
      const bound = { version: comparator.semver, inclusive: operator !== '>' && operator !== '<' }
      if (operator !== '<' && operator !== '<=') setLower = maxLower(setLower, bound)
      if (operator !== '>' && operator !== '>=') setUpper = minUpper(setUpper, bound)
    }
    lower = lower === undefined ? setLower : minLower(lower, setLower)
    upper = upper === undefined ? setUpper : maxUpper(upper, setUpper)
  }
  return { lower: lower ?? null, upper: upper ?? null }
}

/** `<0.2.0-0` is how ranges say "below 0.2.0, its prereleases too"; people read it as 0.2.0. */
function shown(version: SemVer): string {
  return version.version.endsWith('-0') ? version.version.slice(0, -2) : version.version
}

const SYMBOLS: Record<string, string> = { '>=': '≥ ', '<=': '≤ ', '>': '> ', '<': '< ', '': '', '=': '' }

/** "≥ 0.1.7-rc.1 且 < 0.2.0", with `||` alternatives joined by "或". */
export function describeRange(range: string): string {
  return new semver.Range(range, OPTIONS).set
    .map((set) => {
      const parts = set.filter(comparator => comparator.value !== '').map(comparator => `${SYMBOLS[comparator.operator] ?? ''}${shown(comparator.semver)}`)
      return parts.length === 0 ? '任意版本' : parts.join(' 且 ')
    })
    .join(' 或 ')
}

/**
 * One phrase for everything a plugin asks of one package — of dsh itself for the lockstep peers.
 * The ranges must all hold at once, so the phrase names the tightest bound `current` misses: the
 * version to move to, not the whole range.
 */
function describeNeed(subject: string, ranges: readonly string[], failing: string, current: string): string {
  if (semver.valid(current) === null) return `需要 ${subject} ${describeRange(failing)}`
  let lower: Bound | null = null
  let upper: Bound | null = null
  for (const range of ranges) {
    const bounds = rangeBounds(range)
    lower = maxLower(lower, bounds.lower)
    upper = minUpper(upper, bounds.upper)
  }
  if (lower !== null && upper !== null && lower.inclusive && upper.inclusive && semver.eq(lower.version, upper.version)) {
    return `需要 ${subject} ${shown(lower.version)}`
  }
  if (lower !== null && (lower.inclusive ? semver.lt(current, lower.version) : semver.lte(current, lower.version))) {
    return `需要 ${subject} ${lower.inclusive ? '≥' : '>'} ${shown(lower.version)}`
  }
  if (upper !== null && (upper.inclusive ? semver.gt(current, upper.version) : semver.gte(current, upper.version))) {
    return `只支持 ${subject} ${upper.inclusive ? '≤' : '<'} ${shown(upper.version)}`
  }
  return `需要 ${subject} ${describeRange(failing)}`
}

/**
 * Check a plugin's peer ranges on `@deepseek-ai/*` packages against a dsh installation — the
 * copies it resolves at runtime. Ranges on the lockstep `dsh*` packages are ranges on dsh; the
 * rest (`cordis`, `schemastery`, …) have their own versions and are checked against what the
 * installation ships, or skipped when that is not known.
 */
export function assessCompat(peers: Readonly<Record<string, string>> | undefined, host: DshHost | null): CompatResult {
  const declared = Object.entries(peers ?? {})
    .filter(([name, range]) => name.startsWith(OFFICIAL) && semver.validRange(range, OPTIONS) !== null)
  const dshRanges = declared.filter(([name]) => isLockstep(name)).map(([, range]) => range)
  if (host === null) return { compat: 'unknown', note: null, needs: [], dshRanges }
  if (declared.length === 0) return { compat: 'unknown', note: '未声明兼容的 dsh 版本', needs: [], dshRanges }
  const failing = dshRanges.find(range => !semver.satisfies(host.version, range, OPTIONS))
  const dshNeed = failing === undefined ? null : describeNeed('dsh', dshRanges, failing, host.version)
  const needs = dshNeed === null ? [] : [dshNeed]
  let checked = dshRanges.length
  for (const [name, range] of declared) {
    const shipped = isLockstep(name) ? undefined : host.packages.get(name)
    if (shipped === undefined || semver.valid(shipped) === null) continue
    checked += 1
    if (!semver.satisfies(shipped, range, OPTIONS)) needs.push(`${describeNeed(name, [range], range, shipped)}，dsh ${host.version} 自带的是 ${shipped}`)
  }
  if (needs.length > 0) {
    const notes = dshNeed === null ? needs : [`${dshNeed}，当前是 ${host.version}`, ...needs.slice(1)]
    return { compat: 'warn', note: notes.join('；'), needs, dshRanges }
  }
  // Ranges only on packages whose shipped version is unknown here: nothing was actually checked.
  return { compat: checked > 0 ? 'ok' : 'unknown', note: null, needs, dshRanges }
}

/**
 * The newest published dsh version above `current` that every plugin's dsh ranges accept, or null.
 * Only upgrades: a plugin that has fallen behind dsh wants an update, not an older dsh.
 * `versions` is newest first; the tag says which channel carries it.
 */
export function suggestDsh(
  rangesPerPlugin: ReadonlyArray<readonly string[]>, versions: readonly string[], tags: Readonly<Record<string, string>>, current: string,
): DshSuggestion | null {
  const version = versions.find(candidate => semver.valid(candidate) !== null && semver.gt(candidate, current)
    && rangesPerPlugin.every(ranges => ranges.every(range => semver.satisfies(candidate, range, OPTIONS))))
  if (version === undefined) return null
  const tag = Object.entries(tags).find(([, tagged]) => tagged === version)?.[0] ?? null
  return { version, tag }
}
