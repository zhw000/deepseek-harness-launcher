import type { CheckStatus, MirrorId, Settings } from '../../shared/types'
import { USER_AGENT, type FetchFn } from './http'
import { MIRROR_PRESETS } from './mirrors'

/**
 * Proxy variables set to an empty string. pnpm parses an empty proxy and dies with
 * "Invalid URL" on every install, so this is checked explicitly.
 */
export function emptyProxyVariables(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /proxy/i.test(key) && value !== undefined && value.trim() === '')
    .map(([key]) => key)
    .sort()
}

/** A small, always-present packument: its fetch covers DNS, TLS and a real transfer. */
const PROBE_PACKAGE = '@deepseek-ai%2fdsh-home-paths'

export async function measureRegistry(fetchFn: FetchFn, registry: string, samples = 2, timeoutMs = 10_000): Promise<{ ms: number | null; error: string | null }> {
  let best: number | null = null
  let lastError: string | null = null
  for (let sample = 0; sample < samples; sample++) {
    const started = performance.now()
    try {
      const response = await fetchFn(`${registry}/${PROBE_PACKAGE}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
        // Electron serves repeat requests from its HTTP cache, which would time the disk, not the network.
        cache: 'no-store',
      })
      await response.arrayBuffer()
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      const ms = Math.round(performance.now() - started)
      best = best === null ? ms : Math.min(best, ms)
    } catch (error) {
      lastError = error instanceof Error && error.name === 'TimeoutError' ? `${timeoutMs / 1000} 秒内无响应` : error instanceof Error ? error.message : String(error)
    }
  }
  return { ms: best, error: best === null ? lastError ?? '无法连接' : null }
}

export function mirrorCandidates(settings: Pick<Settings, 'customRegistry'>): Array<{ mirror: MirrorId; label: string; registry: string }> {
  const candidates: Array<{ mirror: MirrorId; label: string; registry: string }> = [
    { mirror: 'npmmirror', label: MIRROR_PRESETS.npmmirror.label, registry: MIRROR_PRESETS.npmmirror.registry },
    { mirror: 'official', label: MIRROR_PRESETS.official.label, registry: MIRROR_PRESETS.official.registry },
  ]
  const custom = settings.customRegistry.trim().replace(/\/+$/, '')
  if (custom !== '') candidates.push({ mirror: 'custom', label: '自定义源', registry: custom })
  return candidates
}

/** Latency bands for a registry used for every install: under 1.5s is comfortable. */
export function latencyStatus(ms: number | null): CheckStatus {
  if (ms === null) return 'error'
  return ms <= 1500 ? 'ok' : 'warn'
}
