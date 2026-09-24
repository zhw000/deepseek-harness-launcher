import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyProxyVariables, latencyStatus, measureRegistry, mirrorCandidates } from '../src/main/core/doctor'
import type { FetchFn } from '../src/main/core/http'
import { buildPluginExport, parsePluginList, restoreSpec } from '../src/main/core/plugin-list'
import { hoursUntilCleared, isReleaseAgeBlocked, parseReleaseAgeHolds } from '../src/main/core/plugins'
import { releaseAgeStrict, trustReleaseAge } from '../src/main/core/profiles'
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

describe('release age holds', () => {
  // Verbatim shape of pnpm 11.26's lockfile verification error; mixed errors tag each line.
  const output = [
    '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 3 lockfile entries failed verification:',
    '  @linxin666/dsh-i18n@0.4.1 was published at 2026-09-23T20:10:00.000Z, within the minimumReleaseAge cutoff (2026-09-23T13:00:00.000Z)',
    '  @liustack/modsearch@5.10.5 was published at 2026-09-24T07:08:38.189Z, within the minimumReleaseAge cutoff (2026-09-23T13:00:00.000Z)',
    '  plain-pkg@1.0.0-rc.1 [MINIMUM_RELEASE_AGE_VIOLATION] was published at 2026-09-24T01:00:00.000Z, within the minimumReleaseAge cutoff (2026-09-23T13:00:00.000Z)',
    '  other-pkg@2.0.0 [TARBALL_URL_MISMATCH] has a non-string "tarball" field, so its URL cannot be verified',
    '  weird@not-semver was published at 2026-09-24T01:00:00.000Z, within the minimumReleaseAge cutoff (2026-09-23T13:00:00.000Z)',
    '  …and 4 more',
    '',
    'The lockfile contains entries that the active policies reject.',
  ].join('\n')

  it('recognizes the violation and lists every held version', () => {
    expect(isReleaseAgeBlocked(output)).toBe(true)
    expect(isReleaseAgeBlocked('ERR_PNPM_FETCH_404')).toBe(false)
    expect(parseReleaseAgeHolds(output)).toEqual([
      { name: '@linxin666/dsh-i18n', version: '0.4.1', publishedAt: '2026-09-23T20:10:00.000Z' },
      { name: '@liustack/modsearch', version: '5.10.5', publishedAt: '2026-09-24T07:08:38.189Z' },
      { name: 'plain-pkg', version: '1.0.0-rc.1', publishedAt: '2026-09-24T01:00:00.000Z' },
    ])
  })

  it('reads the single pick strict mode reports on the error line', () => {
    const single = '[ERR_PNPM_NO_MATURE_MATCHING_VERSION] @liustack/modsearch@5.10.5 was published at 2026-09-24T07:08:38.189Z, within the minimumReleaseAge cutoff (2026-09-23T13:00:00.000Z).'
    expect(isReleaseAgeBlocked(single)).toBe(true)
    expect(parseReleaseAgeHolds(single)).toEqual([{ name: '@liustack/modsearch', version: '5.10.5', publishedAt: '2026-09-24T07:08:38.189Z' }])
  })

  it('also holds versions a lagging mirror cannot date', () => {
    const lagging = [
      '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:',
      '  @a/b@1.2.3 could not be checked against minimumReleaseAge (version not present in registry manifest)',
    ].join('\n')
    expect(isReleaseAgeBlocked(lagging)).toBe(true)
    expect(parseReleaseAgeHolds(lagging)).toEqual([{ name: '@a/b', version: '1.2.3', publishedAt: null }])
  })

  it('counts the hours until the newest one clears the one-day window', () => {
    const holds = parseReleaseAgeHolds(output)
    expect(hoursUntilCleared(holds, Date.parse('2026-09-24T13:08:38.189Z'))).toBe(18)
    expect(hoursUntilCleared(holds, Date.parse('2026-09-26T00:00:00.000Z'))).toBe(0)
    const undated = { name: 'x', version: '1.0.0', publishedAt: null }
    expect(hoursUntilCleared([undated])).toBeNull()
    expect(hoursUntilCleared([...holds, undated])).toBeNull()
  })
})

describe('trusting held versions', () => {
  it('adds exact versions to minimumReleaseAgeExclude unless an entry already covers them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-trust-'))
    try {
      const workspace = join(dir, 'pnpm-workspace.yaml')
      await writeFile(join(dir, 'package.json'), '{}\n')
      await writeFile(workspace, 'packages:\n  - .\n\nnodeLinker: hoisted\nminimumReleaseAgeExclude:\n  - dsh-better-sidebar\n')
      const added = await trustReleaseAge(dir, [
        { name: '@liustack/modsearch', version: '5.10.5' },
        { name: 'dsh-better-sidebar', version: '0.19.1' },
        { name: '@liustack/modsearch', version: '5.10.5' },
      ])
      // The bare name already exempts every dsh-better-sidebar version.
      expect(added).toBe(1)
      const text = await readFile(workspace, 'utf8')
      expect(text).toContain('nodeLinker: hoisted')
      expect(text).toContain('- dsh-better-sidebar\n')
      expect(text).toContain('"@liustack/modsearch@5.10.5"')
      expect(text).not.toContain('dsh-better-sidebar@')
      // Trusting again changes nothing.
      expect(await trustReleaseAge(dir, [{ name: '@liustack/modsearch', version: '5.10.5' }])).toBe(0)

      await writeFile(workspace, 'minimumReleaseAgeExclude:\n  - left-pad@1.0.0 || 1.0.1\n')
      expect(await trustReleaseAge(dir, [{ name: 'left-pad', version: '1.0.1' }, { name: 'left-pad', version: '1.0.2' }])).toBe(1)
      expect(await readFile(workspace, 'utf8')).toContain('- left-pad@1.0.2')

      await writeFile(workspace, 'packages:\n  - .\n')
      expect(await trustReleaseAge(dir, [{ name: 'fresh', version: '1.0.0' }])).toBe(1)
      expect(await readFile(workspace, 'utf8')).toContain('minimumReleaseAgeExclude:\n  - fresh@1.0.0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('release age strictness', () => {
  it('follows pnpm: strict only when asked for, or when the age itself is set explicitly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-strict-'))
    try {
      const workspace = join(dir, 'pnpm-workspace.yaml')
      await writeFile(workspace, 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - a@1.0.0\n')
      expect(await releaseAgeStrict(dir, {})).toBe(false)
      expect(await releaseAgeStrict(dir, { pnpm_config_minimum_release_age_strict: 'true' })).toBe(true)
      expect(await releaseAgeStrict(dir, { PNPM_CONFIG_MINIMUM_RELEASE_AGE: '2880' })).toBe(true)
      await writeFile(workspace, 'minimumReleaseAge: 2880\n')
      expect(await releaseAgeStrict(dir, {})).toBe(true)
      await writeFile(workspace, 'minimumReleaseAge: 2880\nminimumReleaseAgeStrict: false\n')
      expect(await releaseAgeStrict(dir, {})).toBe(false)
      await rm(workspace)
      expect(await releaseAgeStrict(dir, {})).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
