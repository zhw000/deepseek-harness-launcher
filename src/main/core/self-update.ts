import semver from 'semver'
import type { LauncherRelease } from '../../shared/types'
import { getJson, HttpError, type FetchFn } from './http'

export const LAUNCHER_REPO = 'zhw000/deepseek-harness-launcher'
export const LAUNCHER_RELEASES_PAGE = `https://github.com/${LAUNCHER_REPO}/releases`

interface GitHubRelease {
  tag_name?: string
  html_url?: string
  published_at?: string | null
  body?: string | null
  draft?: boolean
  prerelease?: boolean
}

/**
 * The newest published launcher release, or null when the repository has none yet.
 * Only full releases count: `releases/latest` skips drafts and prereleases.
 */
export async function fetchLatestLauncherRelease(fetchFn: FetchFn, signal?: AbortSignal): Promise<LauncherRelease | null> {
  try {
    const release = await getJson<GitHubRelease>(fetchFn, `https://api.github.com/repos/${LAUNCHER_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' }, timeoutMs: 15_000, attempts: 2, signal,
    })
    return toRelease(release)
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null
    throw error
  }
}

export function toRelease(release: GitHubRelease): LauncherRelease | null {
  const version = semver.valid(semver.coerce(release.tag_name ?? '', { includePrerelease: true })?.version ?? '')
    ?? semver.valid((release.tag_name ?? '').replace(/^v/, ''))
  if (version === null || release.draft === true) return null
  return {
    version,
    url: release.html_url ?? LAUNCHER_RELEASES_PAGE,
    publishedAt: release.published_at ?? null,
    notes: release.body?.trim() ?? '',
  }
}

/** The release when it is newer than what is running, otherwise null. */
export function newerLauncher(current: string, release: LauncherRelease | null): LauncherRelease | null {
  if (release === null || semver.valid(current) === null) return null
  return semver.gt(release.version, current) ? release : null
}
