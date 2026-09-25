import { Download, FileText, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Channel } from '../../../shared/types'
import { api } from '../api'
import { Banner, Modal, Segmented, Spinner, Switch } from '../components/ui'
import { CHANNELS, formatDate, relativeTime } from '../format'
import { attempt, store, useAction, useAppState } from '../store'

const CHANNEL_ORDER: Channel[] = ['latest', 'next', 'alpha']
const releaseUrl = (version: string) => `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${version}`

function ReleaseNotes({ version, onClose }: { version: string; onClose: () => void }) {
  const [notes, setNotes] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.getReleaseNotes(version).then(setNotes, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [version])
  return (
    <Modal title={`dsh ${version} 更新日志`} onClose={onClose} width={660} footer={(
      <>
        <a onClick={() => void attempt(() => api.openExternal(releaseUrl(version)))}>在 GitHub 上查看</a>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>关闭</button>
      </>
    )}>
      {error !== null
        ? <Banner level="error">获取失败：{error}</Banner>
        : notes === undefined
          ? <div className="row muted"><Spinner />正在从 GitHub 获取…</div>
          : notes === null ? <p className="muted">这个版本没有发布说明。</p> : <pre className="notes">{notes}</pre>}
    </Modal>
  )
}

function Tags({ version, distTags }: { version: string; distTags: Record<string, string> }) {
  return (
    <>
      {Object.entries(distTags).filter(([, tagged]) => tagged === version).map(([tag]) => (
        <span key={tag} className="badge mono">{tag}</span>
      ))}
    </>
  )
}

export function VersionsPage() {
  const state = useAppState()
  const { settings, remote, installed, update, process: proc } = state
  const [checking, runCheck] = useAction()
  const [busy, run] = useAction()
  const [showAll, setShowAll] = useState(false)
  const [notesFor, setNotesFor] = useState<string | null>(null)
  const runningVersion = proc.phase === 'stopped' || proc.phase === 'crashed' ? null : proc.version
  const installedVersions = new Set(installed.map(item => item.version))
  const distTags = remote?.distTags ?? {}
  const remoteVersions = remote?.versions ?? []
  const shown = showAll ? remoteVersions : remoteVersions.slice(0, 8)

  /** Switch — after asking the launch profile's plugins whether they accept `version`. */
  const switchTo = async (version: string, install: boolean) => {
    const profile = settings.launch.profile
    const issues = await api.checkPluginCompat(profile, version).catch(() => [])
    if (issues.length > 0) {
      const ok = await store.ask({
        title: `切换到 dsh ${version}？`,
        message: `配置 ${profile} 里有 ${issues.length} 个插件不支持这个版本：\n\n${issues.map(issue => `${issue.name}：${issue.note}`).join('\n')}\n\n切换后它们可能在浏览器里报错。`,
        confirmText: '仍然切换',
        danger: true,
      })
      if (!ok) return
    }
    await run(() => (install ? api.installVersion(version, true) : api.activateVersion(version)), `已切换到 dsh ${version}`)
  }

  const remove = async (version: string) => {
    const ok = await store.ask({
      title: `删除 dsh ${version}？`,
      message: '只删除这个版本的安装目录，之后可以随时重新安装。插件、配置和会话数据不受影响。',
      confirmText: '删除',
      danger: true,
    })
    if (ok) await run(() => api.removeVersion(version), `已删除 ${version}`)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">版本</h1>
          <p className="page-sub">dsh 以 npm 包 <code>@deepseek-ai/dsh</code> 发布。每个版本独立安装，可以随时切换或回滚。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" disabled={checking} onClick={() => void runCheck(() => api.checkUpdates())}>
            {checking ? <Spinner /> : <RefreshCw size={15} />}检查更新
          </button>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row wrap">
          <div className="grow">
            <div className="card-title">更新通道</div>
            <div className="faint">{CHANNELS[settings.channel].hint}</div>
          </div>
          <Segmented value={settings.channel} onChange={channel => void attempt(() => api.updateSettings({ channel }))}
            options={CHANNEL_ORDER.map(channel => ({
              value: channel,
              label: <>{CHANNELS[channel].label}<span className="seg-tag mono">{distTags[channel] ?? channel}</span></>,
            }))} />
        </div>
        <div className="divider" />
        {update
          ? (
            <Banner level="info" action={(
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void switchTo(update, true)}>
                <Download size={14} />{installedVersions.has(update) ? '切换' : '下载并切换'}
              </button>
            )}>
              可以更新到 <b className="mono">{update}</b>{settings.activeVersion && <>（当前 {settings.activeVersion}）</>}
            </Banner>
          )
          : remote
            ? <Banner level="success">当前已是{CHANNELS[settings.channel].label}通道的最新版本 <span className="faint">· 检查于 {relativeTime(remote.checkedAt)}</span></Banner>
            : <Banner level="info">还没有检查过更新，点击右上角“检查更新”。</Banner>}
        <div className="row wrap" style={{ marginTop: 14, columnGap: 26 }}>
          <label className="row">
            <Switch on={settings.autoCheck} onChange={autoCheck => void attempt(() => api.updateSettings({ autoCheck }))} />自动检查更新
          </label>
          <label className="row">
            <Switch on={settings.autoDownload} onChange={autoDownload => void attempt(() => api.updateSettings({ autoDownload }))} />
            自动下载新版本，下次启动时切换
          </label>
          <label className="row">
            保留旧版本
            <select className="select" value={settings.keepVersions} onChange={event => void attempt(() => api.updateSettings({ keepVersions: Number(event.target.value) }))}>
              {[0, 1, 2, 3, 5].map(count => <option key={count} value={count}>{count} 个</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="section-title">已安装</div>
      <div className="card list">
        {installed.length === 0 && <div className="empty">还没有安装任何版本。</div>}
        {installed.map((item) => {
          const active = item.version === settings.activeVersion
          const running = item.version === runningVersion
          return (
            <div key={item.version} className="list-row">
              <div className="grow">
                <div className="row wrap">
                  <span className="mono strong">{item.version}</span>
                  {active && <span className="badge accent">使用中</span>}
                  {running && <span className="badge success">运行中</span>}
                  {item.version === settings.pendingVersion && <span className="badge">待切换</span>}
                  <Tags version={item.version} distTags={distTags} />
                </div>
                <div className="faint">安装于 {formatDate(item.installedAt, true)}</div>
              </div>
              <button type="button" className="btn ghost sm" onClick={() => setNotesFor(item.version)}><FileText size={14} />更新日志</button>
              {!active && (
                <button type="button" className="btn sm" disabled={busy} onClick={() => void switchTo(item.version, false)}>切换</button>
              )}
              {!active && !running && (
                <button type="button" className="btn ghost sm icon danger" title="删除" disabled={busy} onClick={() => void remove(item.version)}><Trash2 size={14} /></button>
              )}
            </div>
          )
        })}
      </div>

      <div className="section-title">可安装的版本</div>
      <div className="card list">
        {remoteVersions.length === 0 && <div className="empty">{remote ? '没有找到可用版本。' : '点击“检查更新”获取版本列表。'}</div>}
        {shown.map(item => (
          <div key={item.version} className="list-row">
            <div className="grow">
              <div className="row wrap">
                <span className="mono strong">{item.version}</span>
                <Tags version={item.version} distTags={distTags} />
              </div>
              <div className="faint">发布于 {formatDate(item.time, true)}</div>
            </div>
            <button type="button" className="btn ghost sm" onClick={() => setNotesFor(item.version)}><FileText size={14} />更新日志</button>
            {installedVersions.has(item.version)
              ? <span className="badge success">已安装</span>
              : (
                <>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => api.installVersion(item.version, false), `已安装 ${item.version}`)}>安装</button>
                  <button type="button" className="btn sm primary" disabled={busy} onClick={() => void switchTo(item.version, true)}>安装并切换</button>
                </>
              )}
          </div>
        ))}
        {remoteVersions.length > 8 && (
          <button type="button" className="list-more" onClick={() => setShowAll(!showAll)}>
            {showAll ? '收起' : `显示全部 ${remoteVersions.length} 个版本`}
          </button>
        )}
      </div>
      {notesFor && <ReleaseNotes version={notesFor} onClose={() => setNotesFor(null)} />}
    </div>
  )
}
