import { describe, expect, it } from 'vitest'
import {
  baseScore, categoriesOf, factsAdjustment, freshnessScore, exactness, limitPerPublisher, looksLikeDshPlugin, popularityScore, textScore, tokenize,
  type IndexEntry,
} from '../src/main/core/market'

const entry = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  name: 'dsh-thing', version: '1.0.0', description: '', keywords: [], date: new Date().toISOString(),
  publisher: 'someone', npm: null, repository: null, homepage: null, weekly: 100, ...over,
})

describe('query tokenizing', () => {
  it('splits ASCII queries on separators and keeps CJK as one token', () => {
    expect(tokenize('  Memory  MCP ')).toEqual(['memory', 'mcp'])
    expect(tokenize('cost-meter')).toEqual(['cost', 'meter'])
    expect(tokenize('记忆')).toEqual(['记忆'])
    expect(tokenize('记忆 插件')).toEqual(['记忆', '插件'])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('text matching', () => {
  const memory = entry({ name: 'dsh-mnemon', keywords: ['memory', 'agent-memory'], description: '三层记忆控制平面' })

  it('ranks a name hit above a keyword hit above a description hit', () => {
    const byName = textScore(entry({ name: 'dsh-memory' }), ['memory'])!
    const byKeyword = textScore(entry({ keywords: ['memory'] }), ['memory'])!
    const byDescription = textScore(entry({ description: 'persistent memory' }), ['memory'])!
    expect(byName).toBeGreaterThan(byKeyword)
    expect(byKeyword).toBeGreaterThan(byDescription)
  })

  it('matches Chinese queries against Chinese descriptions', () => {
    expect(textScore(memory, ['记忆'])).toBeGreaterThan(0)
    expect(textScore(memory, ['主题'])).toBeNull()
  })

  it('requires every token to match somewhere', () => {
    expect(textScore(memory, ['memory', 'mcp'])).toBeNull()
    expect(textScore(memory, ['memory', 'mnemon'])).toBeGreaterThan(0)
  })

  it('ignores the dsh- prefix authors all share', () => {
    expect(textScore(entry({ name: 'dsh-theme' }), ['theme'])).toBe(1)
  })
})

describe('quality signals', () => {
  it('scores downloads on a log scale so a 10x gap does not swamp relevance', () => {
    expect(popularityScore(0)).toBe(0)
    expect(popularityScore(100_000)).toBe(1)
    expect(popularityScore(1000)).toBeCloseTo(0.6, 1)
    expect(popularityScore(null)).toBe(0)
  })

  it('keeps a fortnight fresh and decays afterwards', () => {
    const now = Date.now()
    const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString()
    expect(freshnessScore(daysAgo(3), now)).toBe(1)
    expect(freshnessScore(daysAgo(90), now)).toBeLessThan(0.7)
    expect(freshnessScore(daysAgo(400), now)).toBeLessThan(0.1)
    expect(freshnessScore(null, now)).toBe(0.2)
  })

  it('rewards real bundles and punishes what will not load', () => {
    const plain = { bundle: null, compat: 'unknown' as const, deprecated: null }
    const base = factsAdjustment('dsh-x', [], 'a plugin', plain)
    expect(factsAdjustment('dsh-x', [], 'a plugin', { ...plain, bundle: true })).toBeGreaterThan(base)
    expect(factsAdjustment('dsh-x', [], 'a plugin', { ...plain, bundle: false })).toBeLessThan(base - 0.2)
    expect(factsAdjustment('dsh-x', [], 'a plugin', { ...plain, compat: 'warn' })).toBeLessThan(base)
    expect(factsAdjustment('dsh-x', [], 'a plugin', { ...plain, deprecated: 'use y' })).toBeLessThan(base - 0.4)
    expect(factsAdjustment('@deepseek-ai/dsh-x', [], 'a plugin', plain)).toBeGreaterThan(base)
    // Keyword stuffing and empty descriptions are demoted.
    expect(factsAdjustment('dsh-x', Array.from({ length: 30 }, (_, i) => `k${i}`), '', plain)).toBeLessThan(base)
  })
})

describe('ranking', () => {
  const now = Date.now()
  const old = new Date(now - 400 * 86_400_000).toISOString()

  it('prefers the relevant plugin over the merely popular one', () => {
    const relevant = entry({ name: 'dsh-memory-bank', weekly: 500 })
    const popular = entry({ name: 'dsh-unrelated', description: 'has memory somewhere', weekly: 90_000 })
    expect(baseScore(relevant, ['memory'], now)!).toBeGreaterThan(baseScore(popular, ['memory'], now)!)
  })

  it('without a query, weighs popularity and recency only', () => {
    const fresh = entry({ weekly: 2000, date: new Date(now).toISOString() })
    const stale = entry({ weekly: 2000, date: old })
    expect(baseScore(fresh, [], now)!).toBeGreaterThan(baseScore(stale, [], now)!)
  })

  it('keeps one author from filling the recommendation list', () => {
    const candidates = ['a', 'a', 'a', 'b', 'a'].map((publisher, index) => ({ entry: entry({ name: `p${index}`, publisher }), score: 1 }))
    expect(limitPerPublisher(candidates, 2).map(c => c.entry.name)).toEqual(['p0', 'p1', 'p3'])
  })

  it('derives topics from indexed keywords', () => {
    const entries = [
      entry({ name: 'a', keywords: ['memory'] }), entry({ name: 'b', keywords: ['agent-memory'] }),
      entry({ name: 'c', keywords: ['memory', 'search'] }), entry({ name: 'd', keywords: ['theme'] }),
    ]
    const categories = categoriesOf(entries)
    expect(categories[0]).toMatchObject({ label: '记忆', query: 'memory', count: 3 })
    // A topic with fewer than three plugins is not worth offering.
    expect(categories.some(category => category.query === 'theme')).toBe(false)
  })
})

describe('exact package names', () => {
  const now = Date.now()

  it('puts the named package first even when a rival is more popular', () => {
    const named = entry({ name: 'dsh-better-sidebar', weekly: null })
    const rival = entry({ name: 'dsh-better-workspace', description: 'sidebar panels', keywords: ['sidebar'], weekly: 30_000 })
    const tokens = tokenize('dsh-better-sidebar')
    expect(baseScore(named, tokens, now, 'dsh-better-sidebar')!).toBeGreaterThan(baseScore(rival, tokens, now, 'dsh-better-sidebar')!)
  })

  it('ranks the typed name above a scoped fork that shares it', () => {
    expect(exactness('dsh-better-sidebar', 'dsh-better-sidebar')).toBe('full')
    expect(exactness('@starpivot/dsh-better-sidebar', 'dsh-better-sidebar')).toBe('bare')
    expect(exactness('dsh-better-sidebar', 'better-sidebar')).toBe('bare')
    expect(exactness('dsh-better-sidebar', 'sidebar')).toBeNull()
    expect(exactness('dsh-thing', '')).toBeNull()
    const tokens = tokenize('dsh-better-sidebar')
    const mine = entry({ name: 'dsh-better-sidebar', weekly: 12_000 })
    const fork = entry({ name: '@starpivot/dsh-better-sidebar', weekly: 12_000 })
    const now = Date.now()
    expect(baseScore(mine, tokens, now, 'dsh-better-sidebar')!).toBeGreaterThan(baseScore(fork, tokens, now, 'dsh-better-sidebar')!)
  })
})

describe('direct name lookups', () => {
  it('accepts dsh plugins and rejects unrelated packages that own a common name', () => {
    expect(looksLikeDshPlugin('dsh-better-sidebar', {})).toBe(true)
    expect(looksLikeDshPlugin('@scope/dsh-thing', {})).toBe(true)
    expect(looksLikeDshPlugin('anything', { dsh: { bundle: { patch: './p.yml' } } })).toBe(true)
    expect(looksLikeDshPlugin('anything', { keywords: ['dsh-plugin'] })).toBe(true)
    // A package called "theme", published in 2015, is not a dsh plugin.
    expect(looksLikeDshPlugin('theme', { keywords: ['css'] })).toBe(false)
    expect(looksLikeDshPlugin('dshoes', {})).toBe(false)
  })
})
