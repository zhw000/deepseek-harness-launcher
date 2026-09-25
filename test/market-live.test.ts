import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { versionHost } from '../src/main/core/compat'
import { MarketService } from '../src/main/core/market'
import type { MarketItem, MarketSort } from '../src/shared/types'

/** Ranking against the real registry. Opt-in: `npm run test:e2e`. */
const enabled = process.env.DSH_E2E === '1'
const root = process.env.DSH_E2E_ROOT ?? join(tmpdir(), 'dsh-launcher-e2e')
const DSH_VERSION = process.env.DSH_E2E_VERSION ?? '0.1.5-rc.2'

describe.skipIf(!enabled)('market ranking on live registry data', () => {
  let market: MarketService

  const search = (query: string, sort: MarketSort = 'relevance', extra: { bundlesOnly?: boolean } = {}) => market.search({
    query, sort, from: 0, size: 8, bundlesOnly: extra.bundlesOnly ?? false, hideIncompatible: false,
  })
  const show = (label: string, items: MarketItem[]) => {
    console.log(`\n### ${label}`)
    for (const item of items) {
      const flags = [item.bundle === true ? 'bundle' : item.bundle === false ? 'NOT-bundle' : 'unknown', item.compat, item.deprecated ? 'deprecated' : '']
      console.log(`  ${item.name.padEnd(34).slice(0, 34)} w=${String(item.weeklyDownloads).padStart(6)} ${(item.date ?? '').slice(0, 10)} ${flags.filter(Boolean).join('/')}`)
    }
  }

  beforeAll(async () => {
    market = new MarketService({
      fetch: (input, init) => fetch(input, init),
      registry: () => 'https://registry.npmjs.org',
      cacheDir: join(root, 'market-cache'),
      dshHost: async () => versionHost(DSH_VERSION),
    })
  })

  it('indexes the whole dsh-plugin keyword set', async () => {
    const started = Date.now()
    const page = await search('')
    console.log(`indexed ${page.indexed} plugins in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    show('推荐（无查询）', page.items)
    console.log('topics:', page.categories.map(category => `${category.label}(${category.count})`).join(' '))
    expect(page.indexed).toBeGreaterThan(1000)
    expect(page.items.length).toBe(8)
  }, 300_000)

  it('answers English and Chinese queries', async () => {
    for (const query of ['memory', '记忆', 'theme', '主题', 'mcp', '终端', 'cost']) {
      show(`查询「${query}」`, (await search(query)).items)
    }
    const memory = await search('memory')
    expect(memory.items.length).toBeGreaterThan(0)
  }, 300_000)

  it('sorts and filters', async () => {
    show('按下载量', (await search('', 'downloads')).items)
    show('按最近更新', (await search('', 'updated')).items)
    const bundles = await search('', 'relevance', { bundlesOnly: true })
    show('只看组合包', bundles.items)
    expect(bundles.items.every(item => item.bundle === true)).toBe(true)
  }, 300_000)
})

describe.skipIf(!enabled)('exact package name lookup', () => {
  it('finds a plugin that publishes no keywords at all', async () => {
    const service = new MarketService({
      fetch: (input, init) => fetch(input, init),
      registry: () => 'https://registry.npmjs.org',
      cacheDir: join(root, 'market-cache'),
      dshHost: async () => versionHost(DSH_VERSION),
    })
    const page = await service.search({ query: 'dsh-better-sidebar', sort: 'relevance', from: 0, size: 5, bundlesOnly: false, hideIncompatible: false })
    console.log('results:', page.items.map(item => `${item.name}@${item.version}`))
    expect(page.items[0]?.name).toBe('dsh-better-sidebar')
  }, 120_000)
})
