import { join } from 'node:path'
import type { Compat, MarketCategory, MarketItem, MarketLookup, MarketPage, MarketQuery } from '../../shared/types'
import { getJson, HttpError, type FetchFn } from './http'
import { SEARCH_ENDPOINT } from './mirrors'
import { assessCompat, type DshHost } from './compat'
import { fetchManifest, fetchPackument, parsePackageSpec, repositoryUrl } from './registry'
import { ensureDir, mapLimit, readJson, writeJsonAtomic } from './util'

/**
 * npm's own ranking is the only thing its search API offers, and for this keyword it is
 * effectively "most downloaded" — its quality/maintenance/popularity details all come back as
 * 1.0 and `dependents` is 0 for nearly every plugin. It also ranks Chinese queries poorly.
 * So the launcher keeps a local index of the whole keyword set and ranks it itself.
 */
export const PLUGIN_KEYWORD = 'dsh-plugin'
/** npm's maximum page size. */
const PAGE_SIZE = 250
const MAX_PACKAGES = 8000
const INDEX_TTL_MS = 6 * 60 * 60 * 1000
const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000
const MANIFEST_BUDGET = 4000

export interface IndexEntry {
  name: string
  version: string
  description: string
  keywords: string[]
  date: string | null
  publisher: string | null
  npm: string | null
  repository: string | null
  homepage: string | null
  weekly: number | null
}

export interface MarketIndex {
  fetchedAt: string
  entries: IndexEntry[]
}

/** What one package manifest says, cached so repeat searches stay instant. */
interface PackageFacts {
  version: string
  bundle: boolean
  peers?: Record<string, string>
  deprecated: string | null
  fetchedAt: number
}

interface SearchResponse {
  total: number
  objects: Array<{
    package: {
      name: string
      version: string
      description?: string
      keywords?: string[]
      date?: string
      publisher?: { username?: string }
      links?: { npm?: string; repository?: string; homepage?: string }
    }
    downloads?: { weekly?: number }
  }>
}

function toEntry(object: SearchResponse['objects'][number]): IndexEntry {
  const pkg = object.package
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description ?? '',
    keywords: pkg.keywords ?? [],
    date: pkg.date ?? null,
    publisher: pkg.publisher?.username ?? null,
    npm: pkg.links?.npm ?? null,
    repository: pkg.links?.repository ?? null,
    homepage: pkg.links?.homepage ?? null,
    weekly: object.downloads?.weekly ?? null,
  }
}

async function fetchPage(fetchFn: FetchFn, from: number, signal?: AbortSignal): Promise<{ total: number; entries: IndexEntry[] }> {
  const text = encodeURIComponent(`keywords:${PLUGIN_KEYWORD}`)
  const response = await getJson<SearchResponse>(fetchFn, `${SEARCH_ENDPOINT}?text=${text}&size=${PAGE_SIZE}&from=${from}`, {
    signal, timeoutMs: 30_000,
  })
  return { total: response.total, entries: response.objects.map(toEntry) }
}

/** Page through the whole keyword set. Duplicates are possible across pages, so names are deduped. */
export async function buildIndex(
  fetchFn: FetchFn,
  options: { signal?: AbortSignal; onProgress?: (fetched: number, total: number) => void } = {},
): Promise<MarketIndex> {
  const seen = new Map<string, IndexEntry>()
  let total = PAGE_SIZE
  for (let from = 0; from < Math.min(total, MAX_PACKAGES); from += PAGE_SIZE) {
    const page = await fetchPage(fetchFn, from, options.signal)
    total = page.total
    for (const entry of page.entries) seen.set(entry.name, entry)
    options.onProgress?.(seen.size, Math.min(total, MAX_PACKAGES))
    if (page.entries.length === 0) break
  }
  return { fetchedAt: new Date().toISOString(), entries: [...seen.values()] }
}

// ---- ranking ----

/** npm publishes download counts on a separate host; a miss just leaves the figure unknown. */
async function weeklyDownloads(fetchFn: FetchFn, name: string): Promise<number | null> {
  try {
    const point = await getJson<{ downloads?: number }>(fetchFn, `https://api.npmjs.org/downloads/point/last-week/${name}`, { timeoutMs: 10_000, attempts: 1 })
    return point.downloads ?? null
  } catch {
    return null
  }
}

/** CJK and Hangul text has no spaces, so such a query stays one token and matches as a substring. */
function hasWideScript(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) return true
  }
  return false
}

export function tokenize(query: string): string[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === '') return []
  if (hasWideScript(trimmed)) return trimmed.split(/[\s,，、]+/).filter(Boolean)
  return trimmed.split(/[\s,，、/_-]+/).filter(Boolean)
}

interface Searchable {
  name: string
  keywords: string[]
  description: string
}

/** Split a name or description into word-ish pieces: "dsh-cost-meter" → dsh, cost, meter. */
function segments(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

const WORD_CHAR = /[a-z0-9]/i

/** Does `token` appear in `text` as a whole word? Written without regex escaping: a query may contain anything. */
function wordMatch(text: string, token: string): boolean {
  for (let from = 0; ; from++) {
    const at = text.indexOf(token, from)
    if (at === -1) return false
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + token.length] ?? ''
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true
    from = at
  }
}

/**
 * How well one package answers the query, or null when a token matches nowhere.
 * Every token must hit something, so "memory mcp" does not return every memory plugin.
 * ASCII tokens match whole words only — otherwise "all" hits "wallpaper" and "ui" hits "build".
 */
export function textScore(entry: Searchable, tokens: readonly string[]): number | null {
  if (tokens.length === 0) return 0
  const name = entry.name.toLowerCase()
  const bare = name.replace(/^@[^/]+\//, '').replace(/^dsh[-_]?/, '')
  const nameParts = segments(name)
  const keywords = entry.keywords.map(keyword => keyword.toLowerCase())
  const keywordParts = keywords.flatMap(segments)
  const description = entry.description.toLowerCase()
  let total = 0
  for (const token of tokens) {
    const wide = hasWideScript(token)
    let best = 0
    if (name === token || bare === token) best = 1
    else if (nameParts.includes(token)) best = 0.9
    else if (bare.startsWith(token) || nameParts.some(part => token.length >= 4 && part.startsWith(token))) best = 0.8
    else if (wide ? name.includes(token) : token.length >= 5 && name.includes(token)) best = 0.7
    else if (keywords.includes(token)) best = 0.7
    else if (keywordParts.includes(token) || (wide && keywords.some(keyword => keyword.includes(token)))) best = 0.55
    else if (wide ? description.includes(token) : wordMatch(description, token)) best = 0.45
    if (best === 0) return null
    total += best
  }
  return total / tokens.length
}

/** 100k weekly downloads reaches 1; the log keeps a 10x gap from swamping relevance. */
export function popularityScore(weekly: number | null): number {
  return Math.min(1, Math.log10(Math.max(0, weekly ?? 0) + 1) / 5)
}

/** Full marks for a fortnight, then a gentle decay: dsh moves fast and stale plugins break. */
export function freshnessScore(date: string | null, now = Date.now()): number {
  if (date === null) return 0.2
  const days = (now - new Date(date).getTime()) / 86_400_000
  if (Number.isNaN(days)) return 0.2
  return days <= 14 ? 1 : Math.exp(-(days - 14) / 150)
}

export interface Facts {
  bundle: boolean | null
  compat: Compat
  deprecated: string | null
}

/** Signals that only the package manifest can answer, applied to the shortlist. */
export function factsAdjustment(name: string, keywords: readonly string[], description: string, facts: Facts): number {
  let delta = 0
  if (name.startsWith('@deepseek-ai/')) delta += 0.06
  if (facts.bundle === true) delta += 0.1
  if (facts.bundle === false) delta -= 0.3
  if (facts.compat === 'warn') delta -= 0.25
  if (facts.deprecated !== null) delta -= 0.45
  // Twenty-plus keywords is keyword stuffing, not description.
  if (keywords.length > 20) delta -= 0.04
  if (description.trim() === '') delta -= 0.05
  return delta
}

/** Only inject a directly looked-up package when it is plausibly a dsh plugin. */
export function looksLikeDshPlugin(name: string, manifest: { dsh?: unknown; keywords?: string[] } | undefined): boolean {
  if (manifest?.dsh !== undefined) return true
  if ((manifest?.keywords ?? []).some(keyword => keyword.toLowerCase().includes('dsh'))) return true
  return /(^|[@/-])dsh([-/]|$)/i.test(name)
}

export type Exactness = 'full' | 'bare' | null

/**
 * Whether the query names this package. A scoped fork that shares the bare name is a weaker
 * match than the package the user actually typed.
 */
export function exactness(name: string, raw: string): Exactness {
  const query = raw.trim().toLowerCase()
  if (query === '') return null
  const lower = name.toLowerCase()
  if (lower === query) return 'full'
  const bare = lower.replace(/^@[^/]+\//, '')
  if (bare === query || bare.replace(/^dsh[-_]?/, '') === query) return 'bare'
  return null
}

export function baseScore(entry: IndexEntry, tokens: readonly string[], now = Date.now(), raw = ''): number | null {
  const text = textScore(entry, tokens)
  if (text === null) return null
  const popularity = popularityScore(entry.weekly)
  const freshness = freshnessScore(entry.date, now)
  if (tokens.length === 0) return 0.55 * popularity + 0.45 * freshness
  // Someone typing a full package name wants that package, however small it is.
  const named = exactness(entry.name, raw)
  const exact = named === 'full' ? 0.5 : named === 'bare' ? 0.2 : 0
  return 0.6 * text + 0.25 * popularity + 0.15 * freshness + exact
}

/** Keyword groups worth offering as topics, with the labels shown in the UI. */
const TOPICS: ReadonlyArray<{ label: string; query: string; keywords: readonly string[] }> = [
  { label: '记忆', query: 'memory', keywords: ['memory', 'agent-memory', 'long-term-memory'] },
  { label: '搜索', query: 'search', keywords: ['search', 'web-search', 'websearch'] },
  { label: '主题美化', query: 'theme', keywords: ['theme', 'skin', 'ui', '主题'] },
  { label: '终端 / TUI', query: 'tui', keywords: ['tui', 'terminal', 'cli'] },
  { label: '子代理', query: 'subagent', keywords: ['subagent', 'multi-agent', 'agent-teams'] },
  { label: '用量与成本', query: 'cost', keywords: ['cost', 'usage', 'billing', 'token-usage'] },
  { label: '办公文档', query: 'office', keywords: ['office', 'docx', 'xlsx', 'pptx', 'document'] },
  { label: 'MCP', query: 'mcp', keywords: ['mcp', 'model-context-protocol'] },
  { label: '会话管理', query: 'session', keywords: ['session', 'session-management', 'archive'] },
  { label: '模型接入', query: 'model', keywords: ['model', 'llm', 'provider', 'proxy'] },
  { label: '技能', query: 'skill', keywords: ['skill', 'skills', 'agent-skill'] },
  { label: '远程访问', query: 'remote', keywords: ['remote', 'mobile', 'tunnel'] },
]

export function categoriesOf(entries: readonly IndexEntry[]): MarketCategory[] {
  return TOPICS
    .map(topic => ({
      label: topic.label,
      query: topic.query,
      count: entries.filter(entry => entry.keywords.some(keyword => topic.keywords.includes(keyword.toLowerCase()))).length,
    }))
    .filter(category => category.count >= 3)
    .sort((a, b) => b.count - a.count)
}

// ---- service ----

export interface MarketContext {
  fetch: FetchFn
  registry: () => string
  cacheDir: string
  /** The active dsh installation, for compatibility checks. */
  dshHost: () => Promise<DshHost | null>
}

export interface RefreshOptions {
  signal?: AbortSignal
  onProgress?: (fetched: number, total: number) => void
}

/** Owns the local index, the manifest cache, and the two-stage search over them. */
export class MarketService {
  private index: MarketIndex | null = null
  private readonly facts = new Map<string, PackageFacts>()
  private loaded = false
  private building: Promise<MarketIndex> | null = null

  constructor(private readonly context: MarketContext) {}

  private get indexFile(): string {
    return join(this.context.cacheDir, 'market-index.json')
  }

  private get factsFile(): string {
    return join(this.context.cacheDir, 'market-facts.json')
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    this.index = await readJson<MarketIndex>(this.indexFile).catch(() => null)
    const stored = await readJson<Record<string, PackageFacts>>(this.factsFile).catch(() => null)
    for (const [name, fact] of Object.entries(stored ?? {})) this.facts.set(name, fact)
  }

  /** Whether a cached index exists, so callers can show progress while the first one is built. */
  async hasIndex(): Promise<boolean> {
    await this.load()
    return this.index !== null
  }

  /** Rebuild the index from the registry; concurrent callers share one run. */
  refresh(options: RefreshOptions = {}): Promise<MarketIndex> {
    this.building ??= buildIndex(this.context.fetch, options)
      .then(async (index) => {
        this.index = index
        await ensureDir(this.context.cacheDir)
        await writeJsonAtomic(this.indexFile, index)
        return index
      })
      .finally(() => {
        this.building = null
      })
    return this.building
  }

  async search(query: MarketQuery): Promise<MarketPage> {
    await this.load()
    if (this.index === null) await this.refresh()
    else if (Date.now() - new Date(this.index.fetchedAt).getTime() > INDEX_TTL_MS) {
      // Serve the cached index now and pick up the refreshed one next time.
      void this.refresh().catch(() => undefined)
    }
    const index = this.index
    if (index === null) throw new Error('无法获取插件索引，请检查网络或下载源设置')

    const tokens = tokenize(query.query)
    const now = Date.now()
    // npm's deep paging overlaps, so the index is a few hundred packages short of the keyword
    // total. One live lookup per query closes that gap — it is what makes an exact package name
    // findable — and its results join the index for later searches.
    let lookup: MarketLookup | null = null
    if (tokens.length > 0 && query.from === 0) {
      const [, exact] = await Promise.all([this.liveSearch(query.query), this.lookupExact(query.query)])
      lookup = exact
    }
    let candidates = index.entries
      .map(entry => ({ entry, score: baseScore(entry, tokens, now, query.query) }))
      .filter((candidate): candidate is { entry: IndexEntry; score: number } => candidate.score !== null)
    candidates.sort(comparator(query.sort))
    // Without a query this is a recommendation list, so one prolific author cannot fill it.
    if (tokens.length === 0) candidates = limitPerPublisher(candidates, 2)

    const size = Math.min(Math.max(query.size ?? 24, 1), 50)
    const wanted = query.from + size
    const window = candidates.slice(0, Math.min(candidates.length, Math.min(wanted + 60, 240)))
    const facts = await this.factsFor(window.map(candidate => candidate.entry))
    const host = await this.context.dshHost()
    const detailed = window.map((candidate) => {
      const item = toItem(candidate.entry, facts.get(candidate.entry.name), host)
      const score = candidate.score + factsAdjustment(item.name, item.keywords, item.description, item)
      return { item, score }
    })
    if (query.sort === 'relevance') detailed.sort((a, b) => b.score - a.score)
    const filtered = detailed.filter(({ item }) => {
      if (query.bundlesOnly && item.bundle !== true) return false
      if (query.hideIncompatible && item.compat === 'warn') return false
      return true
    })
    void this.saveFacts()
    return {
      items: filtered.slice(query.from, wanted).map(({ item }) => item),
      matched: candidates.length,
      indexed: index.entries.length,
      indexedAt: index.fetchedAt,
      more: filtered.length > wanted || window.length < candidates.length,
      categories: tokens.length === 0 ? categoriesOf(index.entries) : [],
      lookup,
    }
  }

  /**
   * Live registry lookups merged into the index, run once per query. Two searches are needed:
   * the keyword one finds what the index missed through npm's overlapping deep paging, and an
   * unrestricted one finds plugins that publish no keywords at all (a scoped package such as
   * `@linxin666/dsh-web-ui-all` is reachable no other way). Unrestricted hits must still look
   * like dsh plugins, or a query like "theme" would drag in half of npm.
   */
  private async liveSearch(query: string): Promise<void> {
    const ask = async (text: string, keep: (entry: IndexEntry, keywords: string[]) => boolean) => {
      try {
        const response = await getJson<SearchResponse>(this.context.fetch, `${SEARCH_ENDPOINT}?text=${encodeURIComponent(text)}&size=25`, { timeoutMs: 20_000 })
        return response.objects.filter(object => keep(toEntry(object), object.package.keywords ?? [])).map(toEntry)
      } catch {
        return []
      }
    }
    const [tagged, loose] = await Promise.all([
      ask(`keywords:${PLUGIN_KEYWORD} ${query}`, () => true),
      ask(query, (entry, keywords) => looksLikeDshPlugin(entry.name, { keywords })),
    ])
    if (this.index === null) return
    const known = new Set(this.index.entries.map(entry => entry.name))
    for (const entry of [...tagged, ...loose]) {
      if (known.has(entry.name)) continue
      known.add(entry.name)
      this.index.entries.push(entry)
    }
  }

  /**
   * Some widely used plugins publish no keywords at all, so no keyword search can reach them.
   * When the query reads like a package name, ask the registry for that exact package, and
   * report back when the answer explains an empty result list.
   */
  private async lookupExact(query: string): Promise<MarketLookup | null> {
    const parsed = parsePackageSpec(query.trim())
    if (parsed === null || this.index === null) return null
    if (this.index.entries.some(entry => entry.name === parsed.name)) return null
    let packument
    try {
      packument = await fetchPackument(this.context.fetch, this.context.registry(), parsed.name, { full: true })
    } catch (error) {
      return error instanceof HttpError && error.status === 404 ? { name: parsed.name, state: 'missing' } : null
    }
    const version = packument['dist-tags']?.latest
    if (version === undefined) return { name: parsed.name, state: 'missing' }
    const manifest = packument.versions[version]
    // A query like "theme" must not drag in an unrelated npm package that happens to own the name.
    if (!looksLikeDshPlugin(packument.name, manifest)) return { name: packument.name, state: 'not-a-plugin' }
    this.index.entries.push({
      name: packument.name,
      version,
      description: manifest?.description ?? '',
      keywords: [],
      date: packument.time?.[version] ?? null,
      publisher: null,
      npm: `https://www.npmjs.com/package/${packument.name}`,
      repository: null,
      homepage: manifest?.homepage ?? null,
      weekly: await weeklyDownloads(this.context.fetch, packument.name),
    })
    return null
  }

  /** Read each package's manifest once a day: it is the only source for `dsh.bundle` and peer ranges. */
  private async factsFor(entries: readonly IndexEntry[]): Promise<Map<string, PackageFacts>> {
    const now = Date.now()
    const missing = entries.filter((entry) => {
      const fact = this.facts.get(entry.name)
      return fact === undefined || fact.version !== entry.version || now - fact.fetchedAt > MANIFEST_TTL_MS
    })
    await mapLimit(missing, 10, async (entry) => {
      try {
        const manifest = await fetchManifest(this.context.fetch, this.context.registry(), entry.name, entry.version)
        this.facts.set(entry.name, {
          version: entry.version,
          bundle: manifest.dsh?.bundle?.patch !== undefined,
          peers: manifest.peerDependencies,
          deprecated: manifest.deprecated ?? null,
          fetchedAt: Date.now(),
        })
      } catch {
        // Leave it unknown; the row still renders, just without the badges.
      }
    })
    return this.facts
  }

  private async saveFacts(): Promise<void> {
    const kept = [...this.facts.entries()]
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, MANIFEST_BUDGET)
    await ensureDir(this.context.cacheDir)
    await writeJsonAtomic(this.factsFile, Object.fromEntries(kept)).catch(() => undefined)
  }
}

function comparator(sort: MarketQuery['sort']): (a: { entry: IndexEntry; score: number }, b: { entry: IndexEntry; score: number }) => number {
  if (sort === 'downloads') return (a, b) => (b.entry.weekly ?? 0) - (a.entry.weekly ?? 0)
  if (sort === 'updated') return (a, b) => Date.parse(b.entry.date ?? '') - Date.parse(a.entry.date ?? '')
  return (a, b) => b.score - a.score || (b.entry.weekly ?? 0) - (a.entry.weekly ?? 0)
}

export function limitPerPublisher<T extends { entry: IndexEntry }>(candidates: readonly T[], limit: number): T[] {
  const seen = new Map<string, number>()
  return candidates.filter((candidate) => {
    const publisher = candidate.entry.publisher ?? candidate.entry.name
    const count = seen.get(publisher) ?? 0
    seen.set(publisher, count + 1)
    return count < limit
  })
}

function toItem(entry: IndexEntry, facts: PackageFacts | undefined, host: DshHost | null): MarketItem {
  const { compat, note } = facts === undefined ? { compat: 'unknown' as Compat, note: null } : assessCompat(facts.peers, host)
  return {
    name: entry.name,
    version: entry.version,
    description: entry.description,
    keywords: entry.keywords,
    date: entry.date,
    publisher: entry.publisher,
    npm: entry.npm ?? `https://www.npmjs.com/package/${entry.name}`,
    repository: entry.repository ?? repositoryUrl(entry.homepage ?? undefined),
    homepage: entry.homepage,
    weeklyDownloads: entry.weekly,
    official: entry.name.startsWith('@deepseek-ai/'),
    bundle: facts === undefined ? null : facts.bundle,
    compat,
    compatNote: note,
    deprecated: facts?.deprecated ?? null,
  }
}
