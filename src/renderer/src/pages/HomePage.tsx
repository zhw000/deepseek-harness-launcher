import { Copy, Download, Eraser, ExternalLink, FileText, FolderOpen, Globe, Play, RotateCw, Square, Terminal } from 'lucide-react'
import type { LaunchSettings } from '../../../shared/types'
import { api } from '../api'
import { LogView } from '../components/LogView'
import { Banner, CommitInput, Spinner, Switch } from '../components/ui'
import { CHANNELS, displayUrl, MIRROR_LABELS, PHASES, shortPath } from '../format'
import { useProfiles } from '../hooks'
import { attempt, store, useAction, useAppState, useStore } from '../store'

function Welcome() {
  const { settings, tasks } = useAppState()
  const [busy, run] = useAction()
  const working = busy || tasks.some(task => task.status === 'running' || task.status === 'queued')
  return (
    <div className="card welcome">
      <div>
        <h2>欢迎使用 DSH Launcher</h2>
        <p className="muted" style={{ margin: 0 }}>一键准备好运行 DeepSeek Harness 所需的一切，不需要预先安装 Node.js 或 pnpm。</p>
        <ul className="steps">
          <li><span className="num">1</span>下载 Node.js LTS 运行时（约 30 MB，SHA-256 校验）</li>
          <li><span className="num">2</span>安装 dsh 插件管理所需的 pnpm 11</li>
          <li><span className="num">3</span>从 npm 安装 dsh（{CHANNELS[settings.channel].label}通道 · {settings.channel}）</li>
        </ul>
        <p className="faint" style={{ margin: '12px 0 0' }}>下载源：{MIRROR_LABELS[settings.mirror]}，可在“设置”中更改。</p>
      </div>
      <button type="button" className="btn primary lg" disabled={working} onClick={() => void run(() => api.setup(), 'dsh 已安装完成，可以启动了')}>
        {working ? <Spinner /> : <Download size={18} />}
        {working ? '正在安装…' : '一键安装'}
      </button>
    </div>
  )
}

function StatusCard() {
  const state = useAppState()
  const { process: proc, settings } = state
  const [busy, run] = useAction()
  const phase = proc.phase
  const running = phase === 'running'
  const transitioning = phase === 'starting' || phase === 'stopping'
  const version = running ? proc.version : settings.activeVersion
  const pending = settings.pendingVersion

  return (
    <div className="card hero">
      <div className="hero-main">
        <div className="grow">
          <div className="hero-status">
            <span className={`dot ${phase}`} />
            dsh {PHASES[phase]}
            {running && proc.url && (
              <a className="badge accent mono" onClick={() => void attempt(() => api.openWebUI())} title="打开 Web 界面">
                {displayUrl(proc.url)}
              </a>
            )}
          </div>
          <div className="hero-meta">
            <span>版本 <b className="mono">{version ?? '—'}</b></span>
            <span>{CHANNELS[settings.channel].label}通道</span>
            <span>配置 <b>{running ? proc.profile : settings.launch.profile}</b></span>
            {running && proc.pid !== null && <span className="faint">PID {proc.pid}</span>}
          </div>
        </div>
        <div className="hero-actions">
          {running && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.restart())}><RotateCw size={16} />重启</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void run(() => api.stop())}><Square size={15} />停止</button>
              <button type="button" className="btn primary lg" onClick={() => void attempt(() => api.openWebUI())}><ExternalLink size={17} />打开 Web 界面</button>
            </>
          )}
          {transitioning && <button type="button" className="btn primary lg" disabled><Spinner />{phase === 'starting' ? '启动中…' : '停止中…'}</button>}
          {(phase === 'stopped' || phase === 'crashed') && (
            <button type="button" className="btn primary lg" disabled={busy} onClick={() => void run(() => api.start())}>
              {busy ? <Spinner /> : <Play size={17} />}启动 dsh
            </button>
          )}
        </div>
      </div>
      {phase === 'crashed' && proc.error && (
        <Banner level="error" action={(
          <>
            {proc.failedPlugin !== null && proc.profile !== null && (
              <button type="button" className="btn sm" disabled={busy} onClick={() => void run(async () => {
                await api.setBundleEnabled(proc.profile!, proc.failedPlugin!, false)
                await api.start()
              }, `已停用 ${proc.failedPlugin}`)}>
                停用该插件并重启
              </button>
            )}
            {proc.diagnostics !== null && (
              <button type="button" className="btn sm" onClick={() => void attempt(() => api.openPath('dshLogs'))}><FileText size={14} />诊断日志</button>
            )}
          </>
        )}>
          <div className="crash-reason">{proc.error}</div>
          {proc.failedPlugin !== null && (
            <div className="faint" style={{ marginTop: 4 }}>
              dsh 指认的插件：<b className="mono">{proc.failedPlugin}</b>。可以停用它，或到“插件”页检查更新——插件常因 dsh 升级而需要更新。
            </div>
          )}
        </Banner>
      )}
      {state.restartRequired && running && (
        <Banner level="warning" action={<button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => api.restart())}>立即重启</button>}>
          插件、版本或启动设置已更改，重启 dsh 后生效。
        </Banner>
      )}
      {pending && <Banner level="info">新版本 <b className="mono">{pending}</b> 已下载，下次启动时自动切换。</Banner>}
      {!pending && state.update && (
        <Banner level="info" action={(
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void run(() => api.installVersion(state.update!, true), `已切换到 dsh ${state.update}`)}>
            更新
          </button>
        )}>
          发现 dsh 新版本 <b className="mono">{state.update}</b>（当前 {settings.activeVersion}）。
        </Banner>
      )}
    </div>
  )
}

function QuickSettings() {
  const { settings, runtime } = useAppState()
  const profiles = useProfiles()
  const launch = settings.launch
  const setLaunch = (patch: Partial<LaunchSettings>) => void attempt(() => api.updateSettings({ launch: patch }))
  const webProfiles = profiles.filter(profile => profile.web)

  return (
    <>
      <div className="grid-4 section">
        <div className="card quick">
          <span className="quick-label">启动配置</span>
          <div className="quick-value">
            <select className="select grow" value={launch.profile} onChange={event => setLaunch({ profile: event.target.value })}>
              {!webProfiles.some(profile => profile.name === launch.profile) && <option value={launch.profile}>{launch.profile}</option>}
              {webProfiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
            </select>
          </div>
        </div>
        <div className="card quick">
          <span className="quick-label">端口</span>
          <div className="quick-value">
            <CommitInput className="input mono grow" type="number" value={String(launch.port)}
              onCommit={value => setLaunch({ port: Number.parseInt(value, 10) || launch.port })} />
          </div>
        </div>
        <div className="card quick">
          <span className="quick-label">工作区（默认工作目录）</span>
          <div className="quick-value">
            <span className="grow ellipsis mono" title={launch.workspace}>{shortPath(launch.workspace, 30)}</span>
            <button type="button" className="btn sm" onClick={() => void attempt(async () => {
              const picked = await api.pickDirectory(launch.workspace)
              if (picked) await api.updateSettings({ launch: { workspace: picked } })
            })}>选择</button>
            <button type="button" className="btn sm icon" title="打开工作区" onClick={() => void attempt(() => api.openPath('workspace'))}><FolderOpen size={14} /></button>
          </div>
        </div>
        <div className="card quick">
          <span className="quick-label"><Globe size={13} />启动后打开浏览器</span>
          <div className="quick-value">
            <Switch on={launch.openBrowser} onChange={openBrowser => setLaunch({ openBrowser })} label="启动后打开浏览器" />
            <span className="faint">{launch.openBrowser ? '自动打开' : '手动打开'}</span>
          </div>
        </div>
      </div>
      <div className="card facts section">
        <span>Node.js <b className="mono">{runtime.nodeVersion ? `v${runtime.nodeVersion}` : '未安装'}</b></span>
        <span>pnpm <b className="mono">{runtime.pnpmVersion ?? '未安装'}</b></span>
        <span className="grow" />
        <a onClick={() => void attempt(() => api.openPath('dshHome'))}>DSH_HOME</a>
        <a onClick={() => void attempt(() => api.openPath('root'))}>启动器数据目录</a>
      </div>
    </>
  )
}

function Console() {
  const logs = useStore(current => current.logs)
  const copy = () => void attempt(() => navigator.clipboard.writeText(logs.map(line => line.text).join('\n')), '日志已复制')
  const clear = () => void attempt(async () => {
    await api.clearLogs()
    store.clearLogs()
  })
  return (
    <div className="section">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="card-title grow"><Terminal size={16} />运行日志</span>
        <button type="button" className="btn ghost sm" onClick={copy} disabled={logs.length === 0}><Copy size={14} />复制</button>
        <button type="button" className="btn ghost sm" onClick={clear} disabled={logs.length === 0}><Eraser size={14} />清空</button>
        <button type="button" className="btn ghost sm" onClick={() => void attempt(() => api.openPath('logs'))}><FolderOpen size={14} />日志目录</button>
      </div>
      <LogView lines={logs} />
    </div>
  )
}

export function HomePage() {
  const { settings } = useAppState()
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">启动</h1>
          <p className="page-sub">启动和停止 DeepSeek Harness 的 Web 界面。</p>
        </div>
      </div>
      {settings.activeVersion === null ? <Welcome /> : <StatusCard />}
      <QuickSettings />
      <Console />
    </div>
  )
}
