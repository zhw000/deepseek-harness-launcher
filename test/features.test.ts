import { describe, expect, it } from 'vitest'
import { emptyProxyVariables, latencyStatus, measureRegistry, mirrorCandidates } from '../src/main/core/doctor'
import type { FetchFn } from '../src/main/core/http'
import { buildPluginExport, parsePluginList, restoreSpec } from '../src/main/core/plugin-list'
import { newerLauncher, toRelease } from '../src/main/core/self-update'
import type { ProfileDetail } from '../src/shared/types'

describe('launcher self-update', () => {
  it('reads a GitHub release, tolerating the v prefix', () => {
    expect(toRelease({ tag_name: 'v1.2.0', html_url: 'https://x/r', published_at: '2026-09-24T00:00:00Z', body: ' notes ' }))
      .toEqual({ version: '1.2.0', url: 'https://x/r', publishedAt: '2026-09-24T00:00:00Z', notes: 'notes' })
    expect(toRelease({ tag_name: 'launcher-2.0.0-beta.1' })?.version).toBe('2.0.0-beta.1')
    expect(toRelease({ tag_name: 'v1.0.0', draft: true })).toBeNull()
    expect(toRelease({ tag_name: 'not-a-version' })).toBeNull()
  })

  it('offers only a strictly newer release', () => {
    const release = { version: '1.1.0', url: 'u', publishedAt: null, notes: '' }
    expect(newerLauncher('1.0.0', release)).toBe(release)
    expect(newerLauncher('1.1.0', release)).toBeNull()
    expect(newerLauncher('1.2.0', release)).toBeNull()
    expect(newerLauncher('1.0.0', null)).toBeNull()
  })
})

describe('diagnostics', () => {
  it('flags empty proxy variables, the cause of pnpm "Invalid URL"', () => {
    expect(emptyProxyVariables({ HTTPS_PROXY: '', pnpm_config_proxy: ' ', NO_PROXY: '*', PATH: '' })).toEqual(['HTTPS_PROXY', 'pnpm_config_proxy'])
    expect(emptyProxyVariables({ HTTPS_PROXY: 'http://127.0.0.1:7890' })).toEqual([])
  })

  it('bands registry latency', () => {
    expect(latencyStatus(200)).toBe('ok')
    expect(latencyStatus(4000)).toBe('warn')
    expect(latencyStatus(null)).toBe('error')
  })

  it('lists the presets plus a configured custom registry', () => {
    expect(mirrorCandidates({ customRegistry: '' }).map(item => item.mirror)).toEqual(['npmmirror', 'official'])
    const withCustom = mirrorCandidates({ customRegistry: 'https://r.example.com/' })
    expect(withCustom.at(-1)).toMatchObject({ mirror: 'custom', registry: 'https://r.example.com' })
  })

  it('times a registry by its best sample and reports why one is unreachable', async () => {
    const ok: FetchFn = async () => new Response('{}', { status: 200 })
    const down: FetchFn = async () => new Response('', { status: 503 })
    const refused: FetchFn = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    const good = await measureRegistry(ok, 'https://r', 2)
    expect(good.error).toBeNull()
    expect(good.ms).toBeGreaterThanOrEqual(0)
    expect(await measureRegistry(down, 'https://r', 1)).toEqual({ ms: null, error: 'HTTP 503' })
    expect(await measureRegistry(refused, 'https://r', 1)).toEqual({ ms: null, error: 'connect ECONNREFUSED' })
  })
})

describe('plugin lists', () => {
  const detail = {
    name: 'web', dir: '/p', exists: true, builtins: [], pendingBuilds: [],
    plugins: [
      { name: 'dsh-a', spec: '^1.2.0', enabled: true },
      { name: 'dsh-b', spec: 'github:u/dsh-b#abc', enabled: false },
    ],
  } as unknown as ProfileDetail

  it('round-trips through its own format', () => {
    const exported = buildPluginExport(detail, '0.1.5-rc.2', new Date('2026-09-24T00:00:00Z'))
    expect(exported).toMatchObject({ format: 'dsh-launcher-plugins', version: 1, profile: 'web', dshVersion: '0.1.5-rc.2' })
    expect(parsePluginList(JSON.parse(JSON.stringify(exported)))).toEqual([
      { name: 'dsh-a', spec: '^1.2.0', enabled: true },
      { name: 'dsh-b', spec: 'github:u/dsh-b#abc', enabled: false },
    ])
  })

  it('also reads a dsh profile package.json copied from another machine', () => {
    const manifest = {
      name: 'dsh-profile-web',
      dependencies: { 'dsh-a': '^1.2.0', 'dsh-plain': '^2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-a'] } },
    }
    expect(parsePluginList(manifest)).toEqual([
      { name: 'dsh-a', spec: '^1.2.0', enabled: true },
      { name: 'dsh-plain', spec: '^2.0.0', enabled: false },
    ])
  })

  it('rejects anything else with a readable reason', () => {
    expect(() => parsePluginList('text')).toThrow(/不是插件列表/)
    expect(() => parsePluginList({ format: 'dsh-launcher-plugins', version: 2, plugins: [] })).toThrow(/版本/)
    expect(() => parsePluginList({ hello: 1 })).toThrow(/无法识别/)
  })

  it('restores each kind of spec, or says why it cannot', () => {
    expect(restoreSpec({ name: 'dsh-a', spec: '^1.2.0', enabled: true })).toEqual({ spec: 'dsh-a@^1.2.0' })
    // Official packages follow the dsh version running here, not the one exported.
    expect(restoreSpec({ name: '@deepseek-ai/dsh-subagent-codex', spec: '0.1.5-rc.1', enabled: true })).toEqual({ spec: '@deepseek-ai/dsh-subagent-codex' })
    expect(restoreSpec({ name: 'dsh-b', spec: 'github:u/dsh-b#abc', enabled: true })).toEqual({ spec: 'github:u/dsh-b#abc' })
    expect(restoreSpec({ name: 'dsh-c', spec: 'https://example.com/dsh-c-1.0.0.tgz', enabled: true })).toEqual({ spec: 'https://example.com/dsh-c-1.0.0.tgz' })
    expect(restoreSpec({ name: 'dsh-d', spec: 'link:C:/dev/dsh-d', enabled: true })).toHaveProperty('skip')
    expect(restoreSpec({ name: 'dsh-e', spec: 'file:C:/dev/dsh-e-1.0.0.tgz', enabled: true })).toHaveProperty('skip')
  })
})
