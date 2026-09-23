import semver from 'semver'
import type { Compat } from '../../shared/types'
import { getJson, type FetchFn } from './http'

export interface VersionManifest {
  name: string
  version: string
  description?: string
  license?: string
  homepage?: string
  repository?: string | { url?: string }
  dsh?: { bundle?: { patch?: string }; migrate?: { to?: string; since?: string } }
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  scripts?: Record<string, string>
  hasInstallScript?: boolean
  deprecated?: string
  bin?: string | Record<string, string>
}

export interface Packument {
  name: string
  'dist-tags': Record<string, string>
  versions: Record<string, VersionManifest>
  time?: Record<string, string>
}

const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'

export function packageUrl(registry: string, name: string): string {
  return `${registry}/${name.startsWith('@') ? name.replace('/', '%2f') : name}`
}

/** Abbreviated documents carry dist-tags and install fields only; `full` adds publish times and metadata. */
export function fetchPackument(fetchFn: FetchFn, registry: string, name: string, options: { full?: boolean; signal?: AbortSignal } = {}): Promise<Packument> {
  return getJson<Packument>(fetchFn, packageUrl(registry, name), {
    signal: options.signal,
    headers: options.full ? {} : { accept: ABBREVIATED },
  })
}

export function fetchManifest(fetchFn: FetchFn, registry: string, name: string, version: string, signal?: AbortSignal): Promise<VersionManifest> {
  return getJson<VersionManifest>(fetchFn, `${packageUrl(registry, name)}/${encodeURIComponent(version)}`, { signal })
}

const NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i

/** Split `name`, `name@range` or `@scope/name@tag`; null for git, path and URL specs. */
export function parsePackageSpec(spec: string): { name: string; range: string | null } | null {
  const trimmed = spec.trim()
  const at = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0)
  const name = at === -1 ? trimmed : trimmed.slice(0, at)
  const range = at === -1 ? null : trimmed.slice(at + 1)
  if (!NAME.test(name) || range === '') return null
  return { name, range }
}

/** Resolve a tag, exact version or range against a packument. */
export function resolveVersion(packument: Packument, range: string | null): string | null {
  const tags = packument['dist-tags'] ?? {}
  if (range === null || range === '' || range === '*') return tags.latest ?? null
  if (tags[range] !== undefined) return tags[range]
  if (packument.versions[range] !== undefined) return range
  if (semver.validRange(range) === null) return null
  return semver.maxSatisfying(Object.keys(packument.versions), range, { includePrerelease: true })
}

export function repositoryUrl(repository: VersionManifest['repository']): string | null {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (!raw) return null
  let url = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '')
  if (url.startsWith('git://')) url = `https://${url.slice('git://'.length)}`
  if (url.startsWith('git@github.com:')) url = `https://github.com/${url.slice('git@github.com:'.length)}`
  if (url.startsWith('github:')) url = `https://github.com/${url.slice('github:'.length)}`
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`
  return /^https?:\/\//.test(url) ? url : null
}

/**
 * dsh publishes its packages in lockstep, so a plugin's peer ranges on
 * `@deepseek-ai/dsh-*` packages tell whether it targets the running dsh version.
 */
export function compatibility(peers: Record<string, string> | undefined, dshVersion: string | null): { compat: Compat; note: string | null } {
  if (dshVersion === null) return { compat: 'unknown', note: null }
  const relevant = Object.entries(peers ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
  if (relevant.length === 0) return { compat: 'unknown', note: '未声明兼容的 dsh 版本' }
  for (const [name, range] of relevant) {
    if (semver.validRange(range) !== null && !semver.satisfies(dshVersion, range, { includePrerelease: true })) {
      return { compat: 'warn', note: `${name} 要求 ${range}，当前 dsh 为 ${dshVersion}` }
    }
  }
  return { compat: 'ok', note: null }
}

export function hasInstallScripts(manifest: VersionManifest): boolean {
  const scripts = manifest.scripts ?? {}
  return manifest.hasInstallScript === true || ['preinstall', 'install', 'postinstall'].some(name => scripts[name] !== undefined)
}
