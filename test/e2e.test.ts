import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LauncherService } from '../src/main/core/launcher'

/**
 * Real downloads, a real dsh and a real pnpm. Opt-in: `npm run test:e2e`.
 * DSH_HOME points into the scratch root, so the user's ~/.dsh is never touched.
 */
const enabled = process.env.DSH_E2E === '1'
const root = process.env.DSH_E2E_ROOT ?? join(tmpdir(), 'dsh-launcher-e2e')
const PROFILE = 'e2e'
const PLUGIN = '@deepseek-ai/dsh-subagent-codex'
const MINUTE = 60_000

describe.skipIf(!enabled)('end to end against npm and a real dsh', () => {
  let service: LauncherService

  beforeAll(async () => {
    service = new LauncherService({
      root: join(root, 'data'),
      launcherVersion: '0.0.0-e2e',
      env: { ...process.env, DSH_HOME: join(root, 'dsh-home') },
      hooks: {
        fetch: (input, init) => fetch(input, init),
        applyProxy: async () => undefined,
        childProxy: async () => undefined,
        openExternal: async () => undefined,
        locale: process.env.DSH_E2E_LOCALE ?? 'zh-CN',
      },
    })
    await service.init()
    await service.updateSettings({
      autoCheck: false,
      launch: { workspace: join(root, 'workspace'), openBrowser: false, disableTelemetry: true, port: 38_080 },
    })
  }, MINUTE)

  afterAll(async () => {
    await service?.dispose()
  })

  it('downloads Node.js, pnpm and the channel version of dsh', async () => {
    await service.setup()
    const state = service.getState()
    expect(state.runtime.nodeVersion).toMatch(/^2[2-9]\./)
    expect(state.runtime.pnpmVersion).toMatch(/^11\./)
    expect(state.settings.activeVersion).toBe(state.remote?.distTags.latest ?? state.settings.activeVersion)
    expect(state.installed.map(install => install.version)).toContain(state.settings.activeVersion)
  }, 20 * MINUTE)

  it('creates a custom web profile from the shipped template', async () => {
    if (!(await service.listProfiles()).some(profile => profile.name === PROFILE)) await service.createProfile(PROFILE)
    expect((await service.listProfiles()).find(profile => profile.name === PROFILE)).toMatchObject({ exists: true, web: true })
  }, 5 * MINUTE)

  it('installs an official plugin pinned to the dsh version, toggles it and removes it', async () => {
    const version = service.getState().settings.activeVersion
    await service.installPlugin(PROFILE, PLUGIN)
    let plugin = (await service.getProfile(PROFILE)).plugins.find(item => item.name === PLUGIN)
    expect(plugin).toMatchObject({ version, spec: version, bundle: true, enabled: true, official: true })

    await service.setBundleEnabled(PROFILE, PLUGIN, false)
    plugin = (await service.getProfile(PROFILE)).plugins.find(item => item.name === PLUGIN)
    expect(plugin?.enabled).toBe(false)
    await service.setBundleEnabled(PROFILE, PLUGIN, true)
    expect(await service.checkPluginUpdates(PROFILE)).toEqual({ updates: [], failures: [] })

    await service.removePlugin(PROFILE, PLUGIN)
    expect((await service.getProfile(PROFILE)).plugins.find(item => item.name === PLUGIN)).toBeUndefined()
  }, 10 * MINUTE)

  it('starts dsh web, signs in with the announced token, and stops through the graceful drain', async () => {
    await service.updateSettings({ launch: { profile: PROFILE } })
    await service.start()
    const status = service.getState().process
    expect(status.phase).toBe('running')
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/)
    // The token URL trades the one-time token for dsh's HttpOnly session cookie.
    const signIn = await fetch(status.url!, { redirect: 'manual' })
    expect(signIn.status).toBe(303)
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(cookie).toMatch(/^dsh-auth-/)
    const page = await fetch(new URL('/', status.url!), { headers: { cookie } })
    expect(page.status).toBe(200)
    expect((await page.text()).toLowerCase()).toContain('<html')
    expect(service.getLogs().some(line => line.text.includes('token=***'))).toBe(true)
    await service.stop()
    expect(service.getState().process).toMatchObject({ phase: 'stopped', exitCode: 0 })
  }, 5 * MINUTE)

  it('searches the plugin market and previews a result', async () => {
    const page = await service.searchMarket({ query: '', sort: 'relevance', from: 0, bundlesOnly: false, hideIncompatible: false })
    expect(page.indexed).toBeGreaterThan(100)
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.categories.length).toBeGreaterThan(0)
    const preview = await service.previewPackage(page.items[0].name)
    expect(preview.name).toBe(page.items[0].name)
  }, MINUTE)
})
