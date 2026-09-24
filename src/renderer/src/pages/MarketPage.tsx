import {
  Boxes, CircleAlert, CircleCheck, Clock, Database, Download, ExternalLink, Info, Package, RefreshCw, Search, ShieldAlert, TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { MarketItem, MarketPage, MarketSort, PackagePreview } from '../../../shared/types'
import { api } from '../api'
import { Banner, Modal, Segmented, Spinner } from '../components/ui'
import { formatCount, relativeTime } from '../format'
import { useProfiles, useTargetProfile } from '../hooks'
import { attempt, useAction, useAppState, useStore } from '../store'

const OFFICIAL = [
  {
    name: '@deepseek-ai/dsh-subagent-codex',
    title: 'Codex 子代理',
    description: '把任务委托给 OpenAI Codex CLI。需要自行安装并登录 Codex，dsh 会从 PATH 找到它。',
  },
  {
    name: '@deepseek-ai/dsh-subagent-claude-code',
    title: 'Claude Code 子代理',
    description: '把任务委托给 Anthropic Claude Code。需要自行安装并登录 Claude Code，dsh 会从 PATH 找到它。',
  },
]

type Tone = 'ok' | 'warn' | 'info' | 'danger' | 'shield'
const TONE_ICON: Record<Tone, ReactNode> = {
  ok: <CircleCheck size={15} className="ok" />,
  warn: <TriangleAlert size={15} style={{ color: 'var(--warning)' }} />,
  info: <Info size={15} style={{ color: 'var(--accent)' }} />,
  danger: <CircleAlert size={15} className="bad" />,
  shield: <ShieldAlert size={15} className="faint" />,
}

function CheckItem({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <div className="check-item">{TONE_ICON[tone]}<span>{children}</span></div>
}

function InstallDialog({ spec, profile, onClose }: { spec: string; profile: string; onClose: () => void }) {
  const [preview, setPreview] = useState<PackagePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, run] = useAction()
  useEffect(() => {
    api.previewPackage(spec).then(setPreview, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [spec])
  const install = async () => {
    if (await run(async () => { await api.installPlugin(profile, spec); return true }, `已安装 ${spec}`)) onClose()
  }
  return (
    <Modal title="安装插件" onClose={onClose} width={560} footer={(
      <>
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={busy || preview === null} onClick={() => void install()}>
          {busy ? <Spinner /> : <Download size={15} />}安装到 {profile}
        </button>
      </>
    )}>
      {error !== null && <Banner level="error">{error}</Banner>}
      {error === null && preview === null && <div className="row muted"><Spinner />正在读取包信息…</div>}
      {preview !== null && (
        <>
          <div className="row wrap">
            <span className="strong">{preview.name}</span>
            <span className="mono faint">{preview.version}</span>
            {preview.license && <span className="badge">{preview.license}</span>}
          </div>
          <p className="muted" style={{ margin: '6px 0 0' }}>{preview.description || '作者没有提供描述。'}</p>
          <div className="check-list">
            {preview.bundle
              ? <CheckItem tone="ok">声明了 <code>dsh.bundle</code>，安装后会作为组合包启用</CheckItem>
              : <CheckItem tone="warn">没有声明 <code>dsh.bundle</code>：只会作为普通依赖安装，dsh 不会加载它</CheckItem>}
            {preview.compat === 'ok' && <CheckItem tone="ok">声明的版本范围兼容当前 dsh</CheckItem>}
            {preview.compat === 'warn' && <CheckItem tone="warn">可能不兼容：{preview.compatNote}</CheckItem>}
            {preview.compat === 'unknown' && <CheckItem tone="info">没有声明兼容的 dsh 版本，安装后请留意启动日志</CheckItem>}
            {preview.installScripts && <CheckItem tone="warn">包含安装脚本。pnpm 会先拦截，需要你确认后才会运行</CheckItem>}
            {preview.migrateTo !== null && (
              <CheckItem tone="warn">作者已把它迁移到 <b className="mono">{preview.migrateTo}</b>，建议改装那个包</CheckItem>
            )}
            {preview.deprecated && <CheckItem tone="danger">作者已弃用：{preview.deprecated}</CheckItem>}
            <CheckItem tone="shield">插件代码会以你的用户权限在 dsh 进程中运行，不受 agent 沙箱限制。请只安装来源可信的插件。</CheckItem>
          </div>
        </>
      )}
    </Modal>
  )
}

function Flags({ item }: { item: MarketItem }) {
  return (
    <>
      {item.official && <span className="badge accent">官方</span>}
      {item.bundle === false && <span className="badge warning" title="没有声明 dsh.bundle，安装后 dsh 不会加载它">非组合包</span>}
      {item.compat === 'warn' && <span className="badge warning" title={item.compatNote ?? ''}><TriangleAlert size={11} />可能不兼容</span>}
      {item.deprecated !== null && <span className="badge danger" title={item.deprecated}>已弃用</span>}
    </>
  )
}

function MarketCard({ item, installed, disabled, onInstall }: { item: MarketItem; installed: boolean; disabled: boolean; onInstall: () => void }) {
  return (
    <div className="card market-card">
      <div className="row">
        <div className={`plugin-icon${item.official ? ' official' : ''}`}><Package size={18} /></div>
        <div className="grow">
          <div className="market-name">{item.name}</div>
          <div className="mono faint">v{item.version}</div>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 6 }}><Flags item={item} /></div>
      <div className="market-desc" title={item.description}>{item.description || '作者没有提供描述。'}</div>
      <div className="market-meta">
        {item.weeklyDownloads !== null && <span title="近 7 天下载量"><Download size={12} />{formatCount(item.weeklyDownloads)} / 周</span>}
        <span title="最近发布"><Clock size={12} />{relativeTime(item.date)}</span>
        {item.publisher && <span>@{item.publisher}</span>}
      </div>
      <div className="row">
        {installed
          ? <span className="badge success">已安装</span>
          : <button type="button" className="btn sm primary" disabled={disabled} onClick={onInstall}>安装</button>}
        <span className="grow" />
        {item.npm && <button type="button" className="btn ghost sm" onClick={() => void attempt(() => api.openExternal(item.npm!))}>npm</button>}
        {item.repository && (
          <button type="button" className="btn ghost sm icon" title="源码仓库" onClick={() => void attempt(() => api.openExternal(item.repository!))}><ExternalLink size={14} /></button>
        )}
      </div>
    </div>
  )
}

const SORTS: ReadonlyArray<{ value: MarketSort; label: string }> = [
  { value: 'relevance', label: '综合' },
  { value: 'downloads', label: '下载量' },
  { value: 'updated', label: '最近更新' },
]

export function MarketPage() {
  const state = useAppState()
  const profiles = useProfiles()
  const [profile, setProfile] = useTargetProfile()
  const revision = useStore(current => current.pluginsRevision)
  const [text, setText] = useState('')
  const [request, setRequest] = useState({ query: '', sort: 'relevance' as MarketSort, bundlesOnly: false, hideIncompatible: false, nonce: 0 })
  const [page, setPage] = useState<MarketPage | null>(null)
  const [items, setItems] = useState<MarketItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set())
  const [installing, setInstalling] = useState<string | null>(null)
  const [busy, run] = useAction()
  const ready = state.settings.activeVersion !== null
  const indexing = state.tasks.some(task => task.title === '更新插件索引' && task.endedAt === null)

  const load = useCallback(async (query: typeof request, from: number) => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.searchMarket({
        query: query.query, sort: query.sort, from, size: 24, bundlesOnly: query.bundlesOnly, hideIncompatible: query.hideIncompatible,
      })
      setPage(result)
      setItems(previous => (from === 0 ? result.items : [...previous, ...result.items]))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(request, 0)
  }, [request, load])

  useEffect(() => {
    if (!ready) return
    let live = true
    api.getProfile(profile).then((detail) => {
      if (live) setInstalled(new Set(detail.plugins.map(plugin => plugin.name)))
    }, () => undefined)
    return () => {
      live = false
    }
  }, [profile, revision, ready])

  const update = (changes: Partial<typeof request>) => setRequest(previous => ({ ...previous, ...changes, nonce: previous.nonce + 1 }))
  const searchFor = (query: string) => {
    setText(query)
    update({ query })
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">插件市场</h1>
          <p className="page-sub">收录 npm 上带 <code>dsh-plugin</code> 关键字的插件，按相关度、下载量与更新时间在本地排序。插件由各自作者发布，启动器不做审核。</p>
        </div>
        <div className="page-actions">
          <select className="select" value={profile} onChange={event => setProfile(event.target.value)} aria-label="安装到配置">
            {!profiles.some(item => item.name === profile) && <option value={profile}>安装到：{profile}</option>}
            {profiles.map(item => <option key={item.name} value={item.name}>安装到：{item.name}</option>)}
          </select>
        </div>
      </div>

      {!ready && <div className="stack" style={{ marginBottom: 14 }}><Banner level="info">安装 dsh 之后才能安装插件。</Banner></div>}

      <div className="search-bar">
        <input className="input grow" value={text} placeholder="搜索插件：记忆、主题、终端、cost、mcp…" spellCheck={false}
          onChange={event => setText(event.target.value)} onKeyDown={event => event.key === 'Enter' && update({ query: text.trim() })} />
        <button type="button" className="btn primary" onClick={() => update({ query: text.trim() })}><Search size={16} />搜索</button>
      </div>

      <div className="row wrap market-tools">
        <Segmented<MarketSort> value={request.sort} onChange={sort => update({ sort })} options={SORTS} />
        <button type="button" className={`chip${request.bundlesOnly ? ' on' : ''}`} onClick={() => update({ bundlesOnly: !request.bundlesOnly })}>
          <Boxes size={13} />只看组合包
        </button>
        <button type="button" className={`chip${request.hideIncompatible ? ' on' : ''}`} onClick={() => update({ hideIncompatible: !request.hideIncompatible })}>
          <CircleCheck size={13} />隐藏不兼容
        </button>
        <span className="grow" />
        {page !== null && (
          <span className="faint row" style={{ gap: 6 }}>
            <Database size={13} />已收录 {formatCount(page.indexed)} 个 · {relativeTime(page.indexedAt)}更新
            <button type="button" className="btn ghost sm" disabled={busy || loading} title="重新抓取 npm 上的插件列表"
              onClick={() => void run(async () => {
                await api.refreshMarketIndex()
                await load(request, 0)
              })}>
              <RefreshCw size={13} />刷新
            </button>
          </span>
        )}
      </div>

      {request.query === '' && page !== null && page.categories.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginTop: 12 }}>
          {page.categories.map(category => (
            <button key={category.query} type="button" className="chip" onClick={() => searchFor(category.query)}>
              {category.label}<span className="faint">{category.count}</span>
            </button>
          ))}
        </div>
      )}

      {request.query === '' && (
        <>
          <div className="section-title">官方可选插件</div>
          <div className="featured">
            {OFFICIAL.map(item => (
              <div key={item.name} className="card market-card">
                <div className="row">
                  <div className="plugin-icon official"><Package size={18} /></div>
                  <div className="grow">
                    <div className="market-name">{item.title}</div>
                    <div className="mono faint">{item.name}</div>
                  </div>
                  {installed.has(item.name)
                    ? <span className="badge success">已安装</span>
                    : <button type="button" className="btn sm primary" disabled={!ready} onClick={() => setInstalling(item.name)}>安装</button>}
                </div>
                <div className="market-desc">{item.description} 版本会与当前 dsh 保持一致。</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="section-title">
        {request.query === '' ? '推荐插件' : `“${request.query}” 的结果`}
        {page !== null && request.query !== '' && <span className="faint">　匹配 {formatCount(page.matched)} 个</span>}
      </div>
      {error !== null && (
        <Banner level="error" action={<button type="button" className="btn sm" onClick={() => void load(request, 0)}>重试</button>}>
          {error}
        </Banner>
      )}
      {page?.lookup != null && (() => {
        const sameName = items.filter(item => item.name.endsWith(`/${page.lookup!.name}`))
        if (page.lookup.state === 'not-a-plugin') {
          return (
            <Banner level="info">
              npm 上有 <b className="mono">{page.lookup.name}</b>，但它不是 dsh 插件：没有声明 <code>dsh.bundle</code>，也没有 dsh 相关关键字，因此不在结果里。
            </Banner>
          )
        }
        return (
          <Banner level="info">
            {sameName.length > 0
              ? <>npm 上没有不带作用域的 <b className="mono">{page.lookup.name}</b>，下面是同名的 <code>@作用域/</code> 版本——注意它们由不同作者发布。</>
              : <>npm 上没有名为 <b className="mono">{page.lookup.name}</b> 的包{items.length > 0 ? '，下面是名字相近的插件。' : '，检查一下拼写？'}</>}
          </Banner>
        )
      })()}
      <div className="market-grid">
        {items.map(item => (
          <MarketCard key={item.name} item={item} installed={installed.has(item.name)} disabled={!ready} onInstall={() => setInstalling(item.name)} />
        ))}
      </div>
      {loading && <div className="empty"><Spinner />{page === null ? (indexing ? '正在建立插件索引，首次使用要多等一会…' : '正在加载插件…') : ''}</div>}
      {!loading && error === null && items.length === 0 && (
        <div className="card empty">
          <p>没有匹配的插件。</p>
          {(request.bundlesOnly || request.hideIncompatible) && <div className="faint">当前启用了筛选条件，可以关掉再试。</div>}
        </div>
      )}
      {!loading && page?.more === true && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button type="button" className="btn" onClick={() => void load(request, items.length)}>加载更多</button>
        </div>
      )}
      {installing && <InstallDialog spec={installing} profile={profile} onClose={() => setInstalling(null)} />}
    </div>
  )
}
