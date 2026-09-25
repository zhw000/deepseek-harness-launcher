import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessCompat, describeRange, suggestDsh, versionHost, type DshHost } from '../src/main/core/compat'
import { installationPackages } from '../src/main/core/profiles'

/** What dsh 0.1.5-rc.3 ships besides its lockstep packages. */
const STABLE: DshHost = {
  version: '0.1.5-rc.3',
  packages: new Map([['@deepseek-ai/dsh', '0.1.5-rc.3'], ['@deepseek-ai/cordis', '4.0.2'], ['@deepseek-ai/schemastery', '3.18.4']]),
}

describe('plugin compatibility with a dsh installation', () => {
  // Ranges below are copied from plugins on npm.
  it('says which dsh a plugin needs when the current one is too old', () => {
    const webAll = { '@deepseek-ai/dsh': '>=0.1.7-rc.1' }
    expect(assessCompat(webAll, STABLE)).toMatchObject({ compat: 'warn', note: '需要 dsh ≥ 0.1.7-rc.1，当前是 0.1.5-rc.3' })
    expect(assessCompat(webAll, versionHost('0.1.7-rc.1'))).toMatchObject({ compat: 'ok', note: null })
  })

  it('folds many lockstep peers into one sentence with the tightest bound', () => {
    const skillHub = {
      '@deepseek-ai/dsh-skill': '>=0.1.7-alpha.1 <0.2.0-0',
      '@deepseek-ai/dsh-session': '>=0.1.7-alpha.1 <0.2.0-0',
      '@deepseek-ai/dsh-client-runtime': '>=0.1.6-alpha.1 <0.2.0-0',
    }
    expect(assessCompat(skillHub, STABLE).note).toBe('需要 dsh ≥ 0.1.7-alpha.1，当前是 0.1.5-rc.3')
  })

  it('says when dsh has moved past what a plugin supports', () => {
    const win32 = { '@deepseek-ai/dsh-fs-local': '>=0.1.0-rc.5 <0.2.0', '@deepseek-ai/dsh-subprocess-local': '>=0.1.0-rc.5 <0.1.0-rc.7' }
    expect(assessCompat(win32, versionHost('0.1.7-rc.1')).note).toBe('只支持 dsh < 0.1.0-rc.7，当前是 0.1.7-rc.1')
    // `^0.1.0-rc.7` ends at 0.2.0-0, which people read as 0.2.0.
    expect(assessCompat({ '@deepseek-ai/dsh-settings': '^0.1.0-rc.7' }, versionHost('0.2.0-rc.1')).note).toBe('只支持 dsh < 0.2.0，当前是 0.2.0-rc.1')
  })

  it('treats dsh prereleases as versions in their own right', () => {
    expect(assessCompat({ '@deepseek-ai/dsh-llm': '>=0.1.5' }, versionHost('0.1.7-rc.1')).compat).toBe('ok')
    expect(assessCompat({ '@deepseek-ai/dsh-llm': '>=0.1.7' }, versionHost('0.1.7-rc.1')).note).toBe('需要 dsh ≥ 0.1.7，当前是 0.1.7-rc.1')
    const vscodeMode = { '@deepseek-ai/dsh-llm': '>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0 || >=0.1.5-0 <0.2.0-0' }
    expect(assessCompat(vscodeMode, versionHost('0.1.7-rc.1')).compat).toBe('ok')
  })

  it('names an exact pin as a version, not a range', () => {
    expect(assessCompat({ '@deepseek-ai/dsh': '0.1.7-rc.1' }, STABLE).note).toBe('需要 dsh 0.1.7-rc.1，当前是 0.1.5-rc.3')
  })

  it('spells out a union when the current version falls between its parts', () => {
    expect(assessCompat({ '@deepseek-ai/dsh': '>=0.1.0 <0.1.2 || >=0.1.4' }, versionHost('0.1.3')).note)
      .toBe('需要 dsh ≥ 0.1.0 且 < 0.1.2 或 ≥ 0.1.4，当前是 0.1.3')
  })

  it('checks independently versioned packages against the copies dsh ships', () => {
    // dsh-memento 0.5.15 on dsh 0.1.5-rc.3: only the bound that fails is worth reading.
    expect(assessCompat({ '@deepseek-ai/cordis': '^4.0.3' }, STABLE))
      .toMatchObject({ compat: 'warn', note: '需要 @deepseek-ai/cordis ≥ 4.0.3，dsh 0.1.5-rc.3 自带的是 4.0.2' })
    expect(assessCompat({ '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/schemastery': '*' }, STABLE).compat).toBe('ok')
    // Without the installation's package list nothing about cordis can be said.
    expect(assessCompat({ '@deepseek-ai/cordis': '^4.0.4' }, versionHost('0.1.5-rc.3'))).toMatchObject({ compat: 'unknown', note: null })
  })

  it('reports the dsh requirement first, then the rest', () => {
    const peers = { '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-tools': '^0.1.7-rc.1' }
    const result = assessCompat(peers, STABLE)
    expect(result.note).toBe('需要 dsh ≥ 0.1.7-rc.1，当前是 0.1.5-rc.3；需要 @deepseek-ai/cordis 4.0.1，dsh 0.1.5-rc.3 自带的是 4.0.2')
    // For "after switching to 0.1.5-rc.3" the version being judged is already in the sentence around it.
    expect(result.needs).toEqual(['需要 dsh ≥ 0.1.7-rc.1', '需要 @deepseek-ai/cordis 4.0.1，dsh 0.1.5-rc.3 自带的是 4.0.2'])
  })

  it('knows nothing without official peers, valid ranges or an installation', () => {
    expect(assessCompat({ react: '^18.0.0' }, STABLE)).toMatchObject({ compat: 'unknown', note: '未声明兼容的 dsh 版本' })
    expect(assessCompat({ '@deepseek-ai/dsh': 'workspace:*' }, STABLE).compat).toBe('unknown')
    expect(assessCompat(undefined, STABLE).compat).toBe('unknown')
    expect(assessCompat({ '@deepseek-ai/dsh': '>=0.1.7-rc.1' }, null)).toMatchObject({ compat: 'unknown', note: null, dshRanges: ['>=0.1.7-rc.1'] })
  })

  it('writes ranges the way people read them', () => {
    expect(describeRange('^0.1.7-rc.1')).toBe('≥ 0.1.7-rc.1 且 < 0.2.0')
    expect(describeRange('*')).toBe('任意版本')
    expect(describeRange('1.2.3')).toBe('1.2.3')
    expect(describeRange('>=1 <2 || 3.0.0')).toBe('≥ 1.0.0 且 < 2.0.0 或 3.0.0')
  })
})

describe('suggesting a dsh version', () => {
  const versions = ['0.2.0-alpha.1', '0.1.7-rc.1', '0.1.5-rc.3']
  const tags = { latest: '0.1.5-rc.3', next: '0.1.7-rc.1' }

  it('picks the newest published version every plugin accepts, with its channel', () => {
    expect(suggestDsh([['>=0.1.7-rc.1'], ['>=0.1.5-rc.1 <0.2.0-0'], []], versions, tags, '0.1.5-rc.3')).toEqual({ version: '0.1.7-rc.1', tag: 'next' })
    expect(suggestDsh([['>=0.1.7-rc.1']], versions, tags, '0.1.5-rc.3')).toEqual({ version: '0.2.0-alpha.1', tag: null })
    expect(suggestDsh([['>=0.3.0']], versions, tags, '0.1.5-rc.3')).toBeNull()
  })

  it('never suggests going back: an outdated plugin wants an update instead', () => {
    expect(suggestDsh([['<0.1.6']], versions, tags, '0.1.7-rc.1')).toBeNull()
  })
})

describe('what a dsh installation ships', () => {
  it('reads every @deepseek-ai package, hoisted or under the dsh package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-host-'))
    try {
      const put = async (path: string, manifest: object) => {
        await mkdir(join(dir, path), { recursive: true })
        await writeFile(join(dir, path, 'package.json'), JSON.stringify(manifest))
      }
      await put('node_modules/@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' })
      await put('node_modules/@deepseek-ai/cordis', { name: '@deepseek-ai/cordis', version: '4.0.4' })
      await put('node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery', { name: '@deepseek-ai/schemastery', version: '3.18.4' })
      await mkdir(join(dir, 'node_modules/@deepseek-ai/broken'), { recursive: true })
      const packages = await installationPackages(dir)
      expect(Object.fromEntries(packages)).toEqual({
        '@deepseek-ai/dsh': '0.1.7-rc.1', '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/schemastery': '3.18.4',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
