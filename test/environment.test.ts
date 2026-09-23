import { describe, expect, it } from 'vitest'
import { childEnvironment } from '../src/main/core/environment'
import { defaultSettings } from '../src/main/core/settings'

const settings = (over: Partial<ReturnType<typeof defaultSettings>> = {}) => ({ ...defaultSettings('/home/u', 'zh-CN'), ...over })
const HOME = '/data/dsh'
const proxyKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).filter(key => /proxy/i.test(key)).sort()

describe('child environment', () => {
  it('points every package manager at the chosen registry', () => {
    const env = childEnvironment({}, settings({ mirror: 'npmmirror' }), HOME, undefined, 'win32')
    expect(env.npm_config_registry).toBe('https://registry.npmmirror.com')
    // pnpm 11 reads only its own prefix, never npm_config_*.
    expect(env.pnpm_config_registry).toBe('https://registry.npmmirror.com')
    expect(env.DSH_HOME).toBe(HOME)
  })

  it('leaves no empty proxy variable behind when the user chose direct', () => {
    const inherited = { HTTP_PROXY: 'http://old:1', https_proxy: 'http://old:1', npm_config_proxy: 'http://old:1' }
    const env = childEnvironment(inherited, settings({ proxyMode: 'none' }), HOME, null, 'win32')
    // pnpm parses an empty proxy and fails with "Invalid URL", so these must be gone entirely.
    for (const key of proxyKeys(env)) expect(env[key], key).not.toBe('')
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.npm_config_proxy).toBeUndefined()
    expect(env.NO_PROXY).toBe('*')
  })

  it('passes a configured proxy to npm, pnpm and dsh', () => {
    const env = childEnvironment({}, settings({ proxyMode: 'custom', proxyUrl: 'http://127.0.0.1:7890' }), HOME, 'http://127.0.0.1:7890', 'win32')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.npm_config_https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.pnpm_config_https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.NO_PROXY).toContain('127.0.0.1')
  })

  it('keeps the inherited proxy when the system decides', () => {
    const env = childEnvironment({ HTTPS_PROXY: 'http://corp:8080' }, settings(), HOME, undefined, 'win32')
    expect(env.HTTPS_PROXY).toBe('http://corp:8080')
  })

  it('drops Electron-only variables and never mutates the inherited environment', () => {
    const inherited = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' }
    const env = childEnvironment(inherited, settings(), HOME, null, 'linux')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(inherited.ELECTRON_RUN_AS_NODE).toBe('1')
    // POSIX tools read either spelling.
    expect(env.no_proxy).toBe('*')
  })
})
