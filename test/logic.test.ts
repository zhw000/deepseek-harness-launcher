import { describe, expect, it } from 'vitest'
import { newerOnChannel, pruneCandidates, toRemoteInfo } from '../src/main/core/dsh-versions'
import { resolveEndpoints } from '../src/main/core/mirrors'
import { nodeArtifact, parseShasums, pickNodeVersion } from '../src/main/core/node-runtime'
import { defaultDataRoot, resolveDshHome } from '../src/main/core/paths'
import { addCommands, explainPnpmFailure, findPluginUpdates, isBuildBlocked, planUpdates, pnpmProgress } from '../src/main/core/plugins'
import { compatibility, parsePackageSpec, repositoryUrl, resolveVersion, type Packument } from '../src/main/core/registry'
import type { PluginInfo } from '../src/shared/types'
import { applySettingsPatch, defaultSettings, normalizeSettings } from '../src/main/core/settings'
import { splitLaunchArgs } from '../src/main/core/supervisor'
import { LineSplitter, mapLimit, splitArgs, stripAnsi } from '../src/main/core/util'

const ESC = String.fromCharCode(27)

describe('util', () => {
  it('strips color escapes', () => {
    expect(stripAnsi(`${ESC}[32mready${ESC}[39m on ${ESC}[1m3080${ESC}[22m`)).toBe('ready on 3080')
  })

  it('splits streamed lines and keeps the visible part of carriage-return redraws', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('first\r\nsec')).toEqual(['first'])
    expect(splitter.push('ond\n10%\r50%\r100%\nta')).toEqual(['second', '100%'])
    expect(splitter.flush()).toEqual(['ta'])
  })

  it('splits arguments with quotes', () => {
    expect(splitArgs(`--trusted-host a.b  --patch "C:/My Files/x.yml" 'two words'`))
      .toEqual(['--trusted-host', 'a.b', '--patch', 'C:/My Files/x.yml', 'two words'])
    expect(splitArgs('')).toEqual([])
    expect(() => splitArgs('"open')).toThrow()
  })

  it('keeps result order under a concurrency limit', async () => {
    const out = await mapLimit([30, 10, 20], 2, async (ms) => {
      await new Promise(resolve => setTimeout(resolve, ms))
      return ms
    })
    expect(out).toEqual([30, 10, 20])
  })
})

describe('endpoints and paths', () => {
  it('resolves mirror presets and custom endpoints', () => {
    expect(resolveEndpoints({ mirror: 'npmmirror', customRegistry: '', customNodeMirror: '' }).registry).toBe('https://registry.npmmirror.com')
    expect(resolveEndpoints({ mirror: 'custom', customRegistry: 'https://r.example.com/', customNodeMirror: '' }))
      .toEqual({ registry: 'https://r.example.com', nodeDist: 'https://nodejs.org/dist' })
  })

  it('resolves DSH_HOME like dsh does', () => {
    expect(resolveDshHome('', {}, '/home/u')).toMatch(/[/\x5c]home[/\x5c]u[/\x5c]\.dsh$/)
    expect(resolveDshHome('', { DSH_HOME: '  ' }, '/home/u')).toMatch(/\.dsh$/)
    expect(resolveDshHome('', { DSH_HOME: '/data/dsh' }, '/home/u')).toBe('/data/dsh')
    expect(resolveDshHome('~/custom', { DSH_HOME: '/data/dsh' }, '/home/u')).toMatch(/[/\x5c]home[/\x5c]u[/\x5c]custom$/)
  })

  it('keeps big files out of the roaming profile on Windows', () => {
    expect(defaultDataRoot('win32', { LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'C:/Users/u')).toMatch(/AppData[/\x5c]Local[/\x5c]dsh-launcher$/)
  })
})

describe('node runtime selection', () => {
  const index = [
    { version: 'v26.9.0', lts: false as const, files: ['win-x64-zip'] },
    { version: 'v24.21.0', lts: 'Krypton', files: ['win-x64-zip', 'osx-arm64-tar'] },
    { version: 'v24.20.0', lts: 'Krypton', files: ['win-x64-zip'] },
    { version: 'v22.18.0', lts: 'Jod', files: ['win-x64-zip', 'linux-x64'] },
  ]

  it('picks the newest LTS that satisfies the dsh engine range', () => {
    expect(pickNodeVersion(index, '^22.19.0 || >=24.0.0', 'win-x64-zip')).toBe('24.21.0')
    expect(pickNodeVersion(index, '^22.19.0 || >=24.0.0', 'linux-x64')).toBeNull()
  })

  it('names platform archives', () => {
    expect(nodeArtifact('24.21.0', 'win32', 'x64')).toMatchObject({ file: 'node-v24.21.0-win-x64.zip', folder: 'node-v24.21.0-win-x64' })
    expect(nodeArtifact('v24.21.0', 'darwin', 'arm64').file).toBe('node-v24.21.0-darwin-arm64.tar.gz')
    expect(() => nodeArtifact('24.21.0', 'win32', 'ia32')).toThrow()
  })

  it('reads SHASUMS256.txt', () => {
    const sum = 'a'.repeat(64)
    expect(parseShasums(`${'b'.repeat(64)}  node-v24.21.0-win-x86.zip\n${sum}  node-v24.21.0-win-x64.zip\n`, 'node-v24.21.0-win-x64.zip')).toBe(sum)
    expect(parseShasums('', 'x.zip')).toBeNull()
  })
})

describe('registry metadata', () => {
  it('parses package specs', () => {
    expect(parsePackageSpec('dsh-cost-meter')).toEqual({ name: 'dsh-cost-meter', range: null })
    expect(parsePackageSpec('@scope/pkg@^1.2.0')).toEqual({ name: '@scope/pkg', range: '^1.2.0' })
    expect(parsePackageSpec('@scope/pkg')).toEqual({ name: '@scope/pkg', range: null })
    expect(parsePackageSpec('github:user/repo')).toBeNull()
    expect(parsePackageSpec('./local')).toBeNull()
  })

  it('resolves tags, versions and ranges', () => {
    const packument = { name: 'p', 'dist-tags': { latest: '1.2.0', next: '2.0.0-rc.1' }, versions: { '1.0.0': {}, '1.2.0': {}, '2.0.0-rc.1': {} } } as unknown as Packument
    expect(resolveVersion(packument, null)).toBe('1.2.0')
    expect(resolveVersion(packument, 'next')).toBe('2.0.0-rc.1')
    expect(resolveVersion(packument, '^1.0.0')).toBe('1.2.0')
    expect(resolveVersion(packument, '9.9.9')).toBeNull()
  })

  it('normalizes repository links', () => {
    expect(repositoryUrl({ url: 'git+https://github.com/a/b.git' })).toBe('https://github.com/a/b')
    expect(repositoryUrl('github:a/b')).toBe('https://github.com/a/b')
    expect(repositoryUrl('a/b')).toBe('https://github.com/a/b')
    expect(repositoryUrl(undefined)).toBeNull()
  })

  it('checks plugin peer ranges against the dsh version, prereleases included', () => {
    const peers = { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7 || ^0.1.1-rc.2', '@deepseek-ai/cordis': '^4.0.1' }
    expect(compatibility(peers, '0.1.5-rc.2').compat).toBe('ok')
    expect(compatibility({ '@deepseek-ai/dsh-settings': '^0.2.0' }, '0.1.5-rc.2')).toMatchObject({ compat: 'warn' })
    expect(compatibility({}, '0.1.5-rc.2').compat).toBe('unknown')
    expect(compatibility(peers, null).compat).toBe('unknown')
  })
})

describe('versions', () => {
  const remote = toRemoteInfo({
    name: '@deepseek-ai/dsh',
    'dist-tags': { latest: '0.1.5-rc.2', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.2' },
    versions: { '0.1.5-rc.1': {}, '0.1.6-alpha.2': {}, '0.1.5-rc.2': {}, junk: {} },
    time: { '0.1.5-rc.2': '2026-09-10T14:57:10.790Z' },
  } as unknown as Packument)

  it('lists valid versions newest first', () => {
    expect(remote.versions.map(v => v.version)).toEqual(['0.1.6-alpha.2', '0.1.5-rc.2', '0.1.5-rc.1'])
    expect(remote.versions[1].time).toBe('2026-09-10T14:57:10.790Z')
  })

  it('reports the channel version only when it is newer', () => {
    expect(newerOnChannel(remote, 'latest', '0.1.5-rc.1')).toBe('0.1.5-rc.2')
    expect(newerOnChannel(remote, 'latest', '0.1.5-rc.2')).toBeNull()
    expect(newerOnChannel(remote, 'latest', '0.1.6-alpha.2')).toBeNull()
    expect(newerOnChannel(remote, 'alpha', '0.1.5-rc.2')).toBe('0.1.6-alpha.2')
    expect(newerOnChannel(remote, 'alpha', null)).toBe('0.1.6-alpha.2')
    expect(newerOnChannel(null, 'latest', null)).toBeNull()
  })

  it('prunes beyond the kept count and never touches protected versions', () => {
    const installed = ['0.1.6-alpha.2', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.3-alpha.2', '0.1.2-rc.1']
    expect(pruneCandidates(installed, 2, ['0.1.6-alpha.2'])).toEqual(['0.1.3-alpha.2', '0.1.2-rc.1'])
    expect(pruneCandidates(installed, 0, ['0.1.2-rc.1', null])).toEqual(['0.1.6-alpha.2', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.3-alpha.2'])
  })
})

describe('plugin commands', () => {
  it('pins official packages exactly and keeps community carets', () => {
    expect(planUpdates([
      { name: '@deepseek-ai/dsh-subagent-codex', current: '0.1.5-rc.1', target: '0.1.5-rc.2', compat: 'ok', compatNote: null },
      { name: 'dsh-cost-meter', current: '1.7.0', target: '1.7.30', compat: 'ok', compatNote: null },
    ])).toEqual([
      ['add', '--save-exact', '@deepseek-ai/dsh-subagent-codex@0.1.5-rc.2'],
      ['add', 'dsh-cost-meter@1.7.30'],
    ])
    expect(planUpdates([])).toEqual([])
  })

  it('explains pnpm failures the way dsh classifies them', () => {
    expect(isBuildBlocked(' ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild')).toBe(true)
    expect(explainPnpmFailure('noise\n ERR_PNPM_FETCH_404  GET https://registry/x: Not Found - 404')).toMatch(/^找不到这个包/)
    expect(explainPnpmFailure('Error: EPERM: operation not permitted, unlink x.node')).toMatch(/^文件被占用/)
    expect(explainPnpmFailure('all good')).toBeNull()
    // pnpm says what went wrong; dsh only says that something did.
    const wrapped = [
      '> dsh plugin --profile web add x',
      '[ERROR] Invalid URL',
      'For help, run: pnpm help add',
      'dsh: pnpm failed in profile directory E:/home/profiles/web',
    ].join('\n')
    expect(explainPnpmFailure(wrapped)).toBe('Invalid URL')
  })
})

describe('settings', () => {
  const defaults = defaultSettings('/home/u', 'zh-CN')

  it('defaults to the China mirror for Chinese locales', () => {
    expect(defaults.mirror).toBe('npmmirror')
    expect(defaultSettings('/home/u', 'en-US').mirror).toBe('official')
  })

  it('drops invalid values instead of trusting them', () => {
    const settings = normalizeSettings({
      channel: 'nightly', keepVersions: 99, mirror: 'official',
      launch: { port: 70000, env: [{ key: 'DEEPSEEK_API_KEY', value: 'k' }, { key: 'bad key', value: 'x' }, 'junk'] },
    }, defaults)
    expect(settings.channel).toBe('latest')
    expect(settings.keepVersions).toBe(2)
    expect(settings.mirror).toBe('official')
    expect(settings.launch.port).toBe(3080)
    expect(settings.launch.env).toEqual([{ key: 'DEEPSEEK_API_KEY', value: 'k' }])
  })

  it('merges nested launch patches', () => {
    const next = applySettingsPatch(defaults, { channel: 'alpha', launch: { port: 8080 } }, defaults)
    expect(next.channel).toBe('alpha')
    expect(next.launch.port).toBe(8080)
    expect(next.launch.profile).toBe('web')
  })

  it('moves --patch overlays ahead of app arguments', () => {
    expect(splitLaunchArgs(['--trusted-host', 'x', '--patch', 'a.yml', '--patch=b.yml'])).toEqual({
      launcherArgs: ['--patch', 'a.yml', '--patch=b.yml'],
      appArgs: ['--trusted-host', 'x'],
    })
  })
})

describe('plugin update checks', () => {
  const REGISTRY = 'https://registry.test'
  const DSH = '0.1.5-rc.2'
  const packuments: Record<string, unknown> = {
    'dsh-cost-meter': {
      'dist-tags': { latest: '1.7.30' },
      versions: { '1.7.30': { peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' } } },
    },
    // Official packages publish in lockstep with dsh; their `latest` tag lags far behind.
    '@deepseek-ai/dsh-subagent-codex': { 'dist-tags': { latest: '0.0.1-rc.1' }, versions: { '0.0.1-rc.1': {}, [DSH]: {} } },
    'dsh-stale': { 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { peerDependencies: { '@deepseek-ai/dsh-base': '^0.2.0' } } } },
    'dsh-current': { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } },
  }
  const fetchStub = async (url: string) => {
    const name = decodeURIComponent(url.slice(`${REGISTRY}/`.length))
    const document = packuments[name]
    return document === undefined
      ? new Response('{"error":"Not found"}', { status: 404 })
      : new Response(JSON.stringify({ name, ...document }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const plugin = (name: string, version: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({
    name, spec: `^${version}`, source: 'registry', version, description: '', homepage: null, bundle: true, enabled: true,
    official: name.startsWith('@deepseek-ai/'), compat: 'unknown', compatNote: null, ...extra,
  })

  it('targets the dsh version for official packages and latest for community ones', async () => {
    const { updates, failures } = await findPluginUpdates(fetchStub, REGISTRY, [
      plugin('dsh-cost-meter', '1.7.2'),
      plugin('@deepseek-ai/dsh-subagent-codex', '0.1.5-rc.1'),
      plugin('dsh-current', '1.0.0'),
      plugin('dsh-local', '1.0.0', { source: 'git', spec: 'github:u/r' }),
    ], DSH)
    expect(failures).toEqual([])
    expect(updates).toEqual([
      { name: 'dsh-cost-meter', current: '1.7.2', target: '1.7.30', compat: 'ok', compatNote: null },
      { name: '@deepseek-ai/dsh-subagent-codex', current: '0.1.5-rc.1', target: DSH, compat: 'unknown', compatNote: '未声明兼容的 dsh 版本' },
    ])
  })

  it('flags an update that no longer supports the running dsh', async () => {
    const { updates } = await findPluginUpdates(fetchStub, REGISTRY, [plugin('dsh-stale', '1.0.0')], DSH)
    expect(updates[0]).toMatchObject({ target: '2.0.0', compat: 'warn' })
    expect(updates[0].compatNote).toContain('^0.2.0')
  })

  it('reports lookups that failed instead of dropping them', async () => {
    const { updates, failures } = await findPluginUpdates(fetchStub, REGISTRY, [
      plugin('dsh-gone', '1.0.0'),
      plugin('dsh-cost-meter', '1.7.2'),
    ], DSH)
    expect(updates).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0].name).toBe('dsh-gone')
    expect(failures[0].error).toContain('404')
  })
})

describe('batching installs', () => {
  it('groups specs into one add per pinning style', () => {
    expect(addCommands([
      { spec: 'dsh-a', exact: false },
      { spec: '@deepseek-ai/dsh-subagent-codex@0.1.5-rc.2', exact: true },
      { spec: 'dsh-b@^1.0.0', exact: false },
      { spec: 'dsh-a', exact: false },
    ])).toEqual([
      ['add', '--save-exact', '@deepseek-ai/dsh-subagent-codex@0.1.5-rc.2'],
      ['add', 'dsh-a', 'dsh-b@^1.0.0'],
    ])
    expect(addCommands([])).toEqual([])
  })

  it('reads progress out of pnpm output', () => {
    expect(pnpmProgress('Verifying lockfile against supply-chain policies (172 entries)...')).toMatch(/供应链/)
    expect(pnpmProgress('Progress: resolved 238, reused 2, downloaded 62, added 63')).toBe('解析 238 个依赖 · 复用 2 · 下载 62 · 写入 63')
    expect(pnpmProgress('Packages: +66 -2')).toBe('变更包：+66 -2')
    expect(pnpmProgress('some other line')).toBeNull()
  })
})
