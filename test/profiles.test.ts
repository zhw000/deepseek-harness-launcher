import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { versionHost } from '../src/main/core/compat'
import {
  classifySpec, decideBuilds, isWebProfile, listProfiles, profileCompatIssues, readPendingBuilds, readProfileDetail, setBundleEnabled,
  validateProfileName, withProfileLock,
} from '../src/main/core/profiles'

const BASE = '@deepseek-ai/dsh-base'
const WEB = '@deepseek-ai/dsh-web-app'
let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-home-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writeProfile(name: string, manifest: object, files: Record<string, string> = {}): Promise<string> {
  const dir = join(home, 'profiles', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, relative)), { recursive: true })
    await writeFile(join(dir, relative), content)
  }
  return dir
}

const readManifest = async (dir: string) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))

describe('profile listing', () => {
  it('offers the shipped web profile before dsh creates it', async () => {
    expect(await listProfiles(home)).toEqual([{ name: 'web', exists: false, shipped: true, web: true, plugins: 0 }])
  })

  it('lists custom profiles, hides desktop and non-profiles, and tells web profiles apart', async () => {
    await writeProfile('desktop', { dsh: { profile: { bundles: [BASE, WEB] } } })
    await writeProfile('work', { dependencies: { 'dsh-x': '^1.0.0' }, dsh: { profile: { bundles: [BASE, WEB, 'dsh-x'] } } })
    await writeProfile('headless', { dsh: { profile: { bundles: [BASE, WEB, '@deepseek-ai/dsh-headless'] } } })
    await mkdir(join(home, 'profiles', 'node_modules'))
    await mkdir(join(home, 'profiles', 'not-a-profile'))
    const profiles = await listProfiles(home)
    expect(profiles.map(profile => [profile.name, profile.web, profile.plugins])).toEqual([
      ['web', true, 0], ['work', true, 1], ['headless', false, 0],
    ])
  })

  it('validates new profile names', () => {
    expect(validateProfileName('my-web_2')).toBeNull()
    expect(validateProfileName('Web')).not.toBeNull()
    expect(validateProfileName('desktop')).not.toBeNull()
    expect(validateProfileName('-x')).not.toBeNull()
    expect(validateProfileName('a b')).not.toBeNull()
    expect(isWebProfile([BASE, WEB])).toBe(true)
    expect(isWebProfile([BASE, '@deepseek-ai/dsh-acp-app'])).toBe(false)
  })
})

describe('bundle toggles and the profile lock', () => {
  it('edits dsh.profile.bundles only, like dsh does', async () => {
    const dir = await writeProfile('work', {
      name: 'dsh-profile-work', private: true, dependencies: { 'dsh-x': '^1.0.0' }, dsh: { profile: { bundles: [BASE, 'dsh-x'] } }, extra: 1,
    })
    expect(await setBundleEnabled(dir, 'dsh-x', false)).toBe(true)
    let manifest = await readManifest(dir)
    expect(manifest.dsh.profile.bundles).toEqual([BASE])
    expect(manifest.dependencies).toEqual({ 'dsh-x': '^1.0.0' })
    expect(manifest.extra).toBe(1)
    expect(await setBundleEnabled(dir, 'dsh-x', false)).toBe(false)
    await setBundleEnabled(dir, 'dsh-x', true)
    manifest = await readManifest(dir)
    expect(manifest.dsh.profile.bundles).toEqual([BASE, 'dsh-x'])
    expect(existsSync(join(dir, 'package.json.lock'))).toBe(false)
  })

  it('waits for a live lock holder and takes over a dead one', async () => {
    const dir = await writeProfile('work', { dsh: { profile: { bundles: [BASE] } } })
    const lock = join(dir, 'package.json.lock')
    await writeFile(lock, `${process.pid}\n`)
    await expect(withProfileLock(dir, async () => 1, 300)).rejects.toThrow(/正被其他进程修改/)
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise(resolve => child.once('exit', resolve))
    await writeFile(lock, `${child.pid}\n`)
    await expect(withProfileLock(dir, async () => 2, 300)).resolves.toBe(2)
    expect(existsSync(lock)).toBe(false)
  })
})

describe('pnpm build approvals', () => {
  it('reads undecided builds and approves exact names only', async () => {
    const dir = await writeProfile('work', { dsh: { profile: { bundles: [BASE] } } }, {
      'pnpm-workspace.yaml': [
        'packages:', '  - .', '', 'nodeLinker: hoisted', 'allowBuilds:',
        '  esbuild: set this to true or false', '  "@scope/native": set this to true or false', '  sharp: false', '  "*": false', '',
      ].join('\n'),
    })
    expect(await readPendingBuilds(dir)).toEqual(['esbuild', '@scope/native'])
    await decideBuilds(dir, ['esbuild'], true)
    expect(await readPendingBuilds(dir)).toEqual(['@scope/native'])
    const text = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    expect(text).toContain('esbuild: true')
    expect(text).toContain('nodeLinker: hoisted')
    await expect(decideBuilds(dir, ['sharp'], true)).rejects.toThrow(/不在待批准列表/)
    // Declining is a decision too: it unblocks pnpm without running the scripts.
    await decideBuilds(dir, ['@scope/native'], false)
    expect(await readPendingBuilds(dir)).toEqual([])
    expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('"@scope/native": false')
  })
})

describe('plugin inventory', () => {
  it('reads installed plugins with bundle, enabled, source and compatibility facts', async () => {
    const manifest = (value: object) => JSON.stringify(value)
    await writeProfile('work', {
      dependencies: { 'dsh-x': '^1.0.0', 'plain-lib': '^2.0.0', 'dsh-git': 'github:u/dsh-git', missing: '^1.0.0' },
      dsh: { profile: { bundles: [BASE, WEB, 'dsh-x'] } },
    }, {
      'node_modules/dsh-x/package.json': manifest({
        name: 'dsh-x', version: '1.2.0', description: 'X', dsh: { bundle: { patch: './cordis.patch.yml' } },
        peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.1' }, repository: 'github:u/dsh-x',
      }),
      'node_modules/plain-lib/package.json': manifest({ name: 'plain-lib', version: '2.1.0' }),
      'node_modules/dsh-git/package.json': manifest({ name: 'dsh-git', version: '0.0.1', dsh: { bundle: { patch: 'p.yml' } } }),
    })
    const detail = await readProfileDetail(home, 'work', {
      host: versionHost('0.1.5-rc.2'),
      installation: [
        { name: BASE, description: 'base' },
        { name: WEB, description: 'web' },
        { name: '@deepseek-ai/dsh-headless', description: 'headless' },
        { name: '@deepseek-ai/dsh-experimental-agent-team-profile', description: 'team' },
      ],
    })
    const byName = Object.fromEntries(detail.plugins.map(plugin => [plugin.name, plugin]))
    expect(byName['dsh-x']).toMatchObject({
      version: '1.2.0', bundle: true, enabled: true, source: 'registry', compat: 'ok', homepage: 'https://github.com/u/dsh-x',
    })
    expect(byName['plain-lib']).toMatchObject({ bundle: false, enabled: false })
    expect(byName['dsh-git']).toMatchObject({ source: 'git', bundle: true, enabled: false })
    expect(byName.missing.version).toBeNull()
    expect(detail.builtins).toEqual([
      { name: BASE, description: 'base', enabled: true, optional: false },
      { name: WEB, description: 'web', enabled: true, optional: false },
      { name: '@deepseek-ai/dsh-experimental-agent-team-profile', description: 'team', enabled: false, optional: true },
    ])
  })

  it('says which dsh each plugin needs, and which published dsh satisfies them all', async () => {
    const manifest = (value: object) => JSON.stringify(value)
    await writeProfile('compat', {
      dependencies: { '@linxin666/dsh-web-all': '^0.4.1', 'dsh-agent-board': '^1.0.0' },
      dsh: { profile: { bundles: [BASE, WEB] } },
    }, {
      'node_modules/@linxin666/dsh-web-all/package.json': manifest({ name: '@linxin666/dsh-web-all', version: '0.4.1', peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.1' } }),
      'node_modules/dsh-agent-board/package.json': manifest({ name: 'dsh-agent-board', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.1.5-rc.1 <0.2.0-0' } }),
    })
    const detail = await readProfileDetail(home, 'compat', {
      host: versionHost('0.1.5-rc.3'),
      installation: [],
      published: { versions: ['0.2.0-alpha.1', '0.1.7-rc.1', '0.1.5-rc.3'], tags: { latest: '0.1.5-rc.3', next: '0.1.7-rc.1' } },
    })
    expect(detail.plugins.find(plugin => plugin.name === '@linxin666/dsh-web-all'))
      .toMatchObject({ compat: 'warn', compatNote: '需要 dsh ≥ 0.1.7-rc.1，当前是 0.1.5-rc.3' })
    expect(detail.plugins.find(plugin => plugin.name === 'dsh-agent-board')?.compat).toBe('ok')
    // 0.2.0-alpha.1 would break the board, so the next channel's 0.1.7-rc.1 is the one to move to.
    expect(detail.dshSuggestion).toEqual({ version: '0.1.7-rc.1', tag: 'next' })

    // Before switching back to an older dsh, the same plugins say what they would need.
    expect(await profileCompatIssues(home, 'compat', versionHost('0.1.5-rc.3'))).toEqual([
      { name: '@linxin666/dsh-web-all', note: '需要 dsh ≥ 0.1.7-rc.1' },
    ])
    expect(await profileCompatIssues(home, 'compat', versionHost('0.1.7-rc.1'))).toEqual([])
  })

  it('classifies dependency specs', () => {
    expect(classifySpec('^1.2.3')).toBe('registry')
    expect(classifySpec('1.2.3')).toBe('registry')
    expect(classifySpec('latest')).toBe('registry')
    expect(classifySpec('github:user/repo#abc123')).toBe('git')
    expect(classifySpec('git+https://github.com/u/r.git')).toBe('git')
    expect(classifySpec('user/repo')).toBe('git')
    expect(classifySpec('link:C:/dev/plugin')).toBe('local')
    expect(classifySpec('file:/tmp/p-1.0.0.tgz')).toBe('tarball')
    expect(classifySpec('https://example.com/p.tgz')).toBe('tarball')
    expect(classifySpec('npm:other@^1')).toBe('other')
  })
})
