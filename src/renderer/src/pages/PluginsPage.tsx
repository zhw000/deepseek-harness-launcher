import {
  Box, CircleArrowUp, ExternalLink, FileDown, FileUp, FolderOpen, Package, PackagePlus, Plus, RefreshCw, Store, Trash2, TriangleAlert,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PluginInfo, PluginUpdate, PluginUpdateCheck, ProfileDetail } from '../../../shared/types'
import { api } from '../api'
import { Banner, Field, Modal, Spinner, Switch } from '../components/ui'
import { SOURCES } from '../format'
import { useProfiles, useTargetProfile } from '../hooks'
import { attempt, navigate, store, useAction, useAppState, useStore } from '../store'

const TRUST_NOTE = '插件代码会以你的用户权限在 dsh 进程中运行，不受 agent 沙箱限制。请只安装来源可信的插件。'

function CreateProfile({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('')
  const [busy, run] = useAction()
  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (await run(async () => { await api.createProfile(trimmed); return true }, `已创建配置 ${trimmed}`)) {
      onCreated(trimmed)
      onClose()
    }
  }
  return (
    <Modal title="新建配置" onClose={onClose} footer={(
      <>
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy && <Spinner />}创建</button>
      </>
    )}>
      <Field label="配置名称" hint="基于 dsh 内置的 web 模板创建。每个配置有独立的插件和设置，会话数据共用。">
        <input className="input" autoFocus value={name} placeholder="例如 work" onChange={event => setName(event.target.value)}
          onKeyDown={event => event.key === 'Enter' && void submit()} />
      </Field>
    </Modal>
  )
}

function InstallBar({ profile }: { profile: string }) {
  const [spec, setSpec] = useState('')
  const [busy, run] = useAction()
  const install = async (value: string) => {
    const target = value.trim()
    if (!target) return
    const ok = await store.ask({ title: `安装 ${target}？`, message: `安装到配置 ${profile}。\n\n${TRUST_NOTE}`, confirmText: '安装' })
    if (ok && await run(async () => { await api.installPlugin(profile, target); return true }, `已安装 ${target}`)) setSpec('')
  }
  const pick = (picker: () => Promise<string | null>) => void attempt(async () => {
    const path = await picker()
    if (path) await install(path)
  })
  return (
    <div className="card card-pad section">
      <div className="card-title"><PackagePlus size={16} />安装插件</div>
      <p className="card-sub">支持 npm 包名（可带版本）、<code>github:用户/仓库#提交</code>、本地插件目录或 <code>.tgz</code> 压缩包。</p>
      <div className="row">
        <input className="input mono grow" value={spec} placeholder="例如 dsh-cost-meter 或 github:user/dsh-plugin" spellCheck={false}
          onChange={event => setSpec(event.target.value)} onKeyDown={event => event.key === 'Enter' && void install(spec)} />
        <button type="button" className="btn primary" disabled={busy || !spec.trim()} onClick={() => void install(spec)}>{busy ? <Spinner /> : <PackagePlus size={15} />}安装</button>
        <button type="button" className="btn" disabled={busy} onClick={() => pick(() => api.pickDirectory())}>本地目录…</button>
        <button type="button" className="btn" disabled={busy} onClick={() => pick(() => api.pickFile())}>压缩包…</button>
      </div>
    </div>
  )
}

function PluginRow({ plugin, update, busy, onToggle, onUpdate, onRemove }: {
  plugin: PluginInfo
  update: PluginUpdate | undefined
  busy: boolean
  onToggle: (enabled: boolean) => void
  onUpdate: () => void
  onRemove: () => void
}) {
  return (
    <div className="list-row">
      <div className={`plugin-icon${plugin.official ? ' official' : ''}`}><Package size={18} /></div>
      <div className="grow">
        <div className="row wrap">
          <span className="strong">{plugin.name}</span>
          <span className="mono faint">{plugin.version ?? '—'}</span>
          {plugin.official && <span className="badge accent">官方</span>}
          {!plugin.bundle && plugin.version !== null && <span className="badge" title="没有声明 dsh.bundle，不会加入配置层">普通依赖</span>}
          {plugin.source !== 'registry' && <span className="badge">{SOURCES[plugin.source]}</span>}
          {plugin.version === null && <span className="badge danger">文件缺失</span>}
          {plugin.compat === 'warn' && <span className="badge warning" title={plugin.compatNote ?? ''}><TriangleAlert size={12} />可能不兼容</span>}
          {update && (
          <span className={`badge ${update.compat === 'warn' ? 'warning' : 'success'}`} title={update.compatNote ?? undefined}>
            <CircleArrowUp size={12} />{update.target}
          </span>
        )}
        </div>
        <div className="faint ellipsis" title={plugin.compatNote ?? plugin.description}>{plugin.description || plugin.spec}</div>
      </div>
      {update && <button type="button" className="btn sm" disabled={busy} onClick={onUpdate}>更新</button>}
      {plugin.homepage && (
        <button type="button" className="btn ghost sm icon" title="主页" onClick={() => void attempt(() => api.openExternal(plugin.homepage!))}><ExternalLink size={14} /></button>
      )}
      <button type="button" className="btn ghost sm icon danger" title="卸载" disabled={busy} onClick={onRemove}><Trash2 size={14} /></button>
      {plugin.bundle
        ? <Switch on={plugin.enabled} disabled={busy} onChange={onToggle} label={`启用 ${plugin.name}`} />
        : <span className="switch-slot" />}
    </div>
  )
}

export function PluginsPage() {
  const state = useAppState()
  const revision = useStore(current => current.pluginsRevision)
  const profiles = useProfiles()
  const [profile, setProfile] = useTargetProfile()
  const [detail, setDetail] = useState<ProfileDetail | null>(null)
  const [check, setCheck] = useState<PluginUpdateCheck | null>(null)
  const [creating, setCreating] = useState(false)
  const [checking, runCheck] = useAction()
  const [busy, run] = useAction()
  const activeVersion = state.settings.activeVersion

  useEffect(() => {
    let live = true
    void attempt(() => api.getProfile(profile)).then((loaded) => {
      if (live && loaded) setDetail(loaded)
    })
    return () => {
      live = false
    }
  }, [profile, revision, activeVersion])
  useEffect(() => setCheck(null), [profile])

  if (activeVersion === null) {
    return (
      <div className="page">
        <div className="page-head"><div><h1 className="page-title">插件</h1></div></div>
        <div className="card empty">
          <Package size={30} />
          <p>安装 dsh 之后才能管理插件。</p>
          <button type="button" className="btn primary" onClick={() => navigate('home')}>前往启动页</button>
        </div>
      </div>
    )
  }

  const plugins = detail?.plugins ?? []
  const running = state.process.phase === 'running' && state.process.profile === profile
  const updateFor = (name: string) => check?.updates.find(update => update.name === name)
  const checkUpdates = () => void runCheck(async () => {
    const found = await api.checkPluginUpdates(profile)
    setCheck(found)
    const count = found.updates.length
    store.notify(count > 0 ? 'info' : 'success', count > 0 ? `${count} 个插件可以更新` : '所有插件都已是最新版本')
  })
  const applyUpdates = (list: PluginUpdate[]) => void run(async () => {
    await api.updatePlugins(profile, list)
    setCheck(previous => (previous === null ? null : { ...previous, updates: previous.updates.filter(update => !list.some(done => done.name === update.name)) }))
  }, list.length === 1 ? `${list[0].name} 已更新到 ${list[0].target}` : `已更新 ${list.length} 个插件`)
  const remove = async (plugin: PluginInfo) => {
    const ok = await store.ask({
      title: `卸载 ${plugin.name}？`,
      message: '会从这个配置中移除该插件和它的组合包层。插件自己保存的数据不会被删除。',
      confirmText: '卸载',
      danger: true,
    })
    if (ok) await run(() => api.removePlugin(profile, plugin.name), `已卸载 ${plugin.name}`)
  }
  const toggle = (name: string, enabled: boolean) => void run(() => api.setBundleEnabled(profile, name, enabled))
  const decide = async (names: string[], allow: boolean) => {
    const ok = await store.ask({
      title: allow ? '允许这些依赖运行构建脚本？' : '拒绝运行这些构建脚本？',
      message: allow
        ? `${names.join('\n')}\n\n构建脚本会以你的用户权限在本机运行，且不受 agent 沙箱限制。只在确认来源可信时允许。`
        : `${names.join('\n')}\n\n它们的构建脚本不会运行，插件仍会安装——多数纯 JS 插件不受影响，少数依赖原生模块的可能功能不全。`,
      confirmText: allow ? '允许并重试' : '拒绝并重试',
      danger: allow,
    })
    if (ok) await run(() => api.decideBuilds(profile, names, allow), allow ? '已允许构建脚本' : '已拒绝构建脚本')
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">插件</h1>
          <p className="page-sub">dsh 中一切都是插件。插件装在配置（profile）里，由 dsh 通过 pnpm 管理，和 Web 界面的插件页共用同一份状态。</p>
        </div>
        <div className="page-actions">
          <select className="select" value={profile} onChange={event => setProfile(event.target.value)} aria-label="配置">
            {!profiles.some(item => item.name === profile) && <option value={profile}>{profile}</option>}
            {profiles.map(item => <option key={item.name} value={item.name}>配置：{item.name}{item.web ? '' : '（非 Web）'}</option>)}
          </select>
          <button type="button" className="btn" onClick={() => setCreating(true)}><Plus size={15} />新建配置</button>
          <button type="button" className="btn" disabled={busy} title="把这个配置的插件列表保存成文件，换电脑或重装后可以一键装回"
            onClick={() => void run(async () => {
              const path = await api.exportPlugins(profile)
              if (path !== null) store.notify('success', `已导出到 ${path}`)
            })}>
            <FileDown size={15} />导出
          </button>
          <button type="button" className="btn" disabled={busy} title="从导出的插件列表，或另一台电脑 dsh 配置目录里的 package.json 安装"
            onClick={() => void run(async () => {
              const result = await api.importPlugins(profile)
              if (result === null) return
              const skipped = result.skipped.length > 0 ? `；跳过 ${result.skipped.length} 个（${result.skipped.map(item => `${item.name}：${item.reason}`).join('，')}）` : ''
              store.notify(result.installed.length > 0 ? 'success' : 'info', `导入完成：安装 ${result.installed.length} 个${skipped}`)
            })}>
            <FileUp size={15} />导入
          </button>
          <button type="button" className="btn icon" title="打开配置目录" onClick={() => void attempt(() => api.openPath('profile', profile))}><FolderOpen size={15} /></button>
        </div>
      </div>

      <div className="stack">
        {running && state.restartRequired && (
          <Banner level="warning" action={<button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => api.restart())}>立即重启</button>}>
            配置 {profile} 正在运行，插件变更需要重启 dsh 才会生效。
          </Banner>
        )}
        {detail !== null && detail.pendingBuilds.length > 0 && (
          <Banner level="warning" action={(
            <>
              <button type="button" className="btn sm" disabled={busy} onClick={() => void decide(detail.pendingBuilds, false)}>不运行</button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => void decide(detail.pendingBuilds, true)}>允许构建…</button>
            </>
          )}>
            pnpm 拒绝运行这些依赖的构建脚本：<b className="mono">{detail.pendingBuilds.join('、')}</b>。在做出选择前，这个配置下的所有安装都会失败。
          </Banner>
        )}
        {check !== null && check.failures.length > 0 && (
          <Banner level="warning">
            {check.failures.length} 个插件无法检查更新：{check.failures.map(failure => `${failure.name}（${failure.error}）`).join('；')}
          </Banner>
        )}
        {detail !== null && !detail.exists && (
          <Banner level="info">配置 {profile} 还没有创建，首次启动或安装插件时由 dsh 自动生成。</Banner>
        )}
      </div>

      <InstallBar profile={profile} />

      <div className="row section">
        <span className="section-title grow" style={{ margin: 0 }}>已安装插件 · {plugins.length}</span>
        <button type="button" className="btn sm" disabled={checking || plugins.length === 0} onClick={checkUpdates}>
          {checking ? <Spinner size={14} /> : <RefreshCw size={14} />}检查更新
        </button>
        {check !== null && check.updates.length > 0 && (
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => applyUpdates(check.updates)}>全部更新（{check.updates.length}）</button>
        )}
      </div>
      <div className="card list" style={{ marginTop: 10 }}>
        {detail === null && <div className="empty"><Spinner /></div>}
        {detail !== null && plugins.length === 0 && (
          <div className="empty">
            <Package size={30} />
            <p>这个配置还没有安装插件。</p>
            <button type="button" className="btn" onClick={() => navigate('market')}><Store size={15} />去插件市场看看</button>
          </div>
        )}
        {plugins.map(plugin => (
          <PluginRow key={plugin.name} plugin={plugin} update={updateFor(plugin.name)} busy={busy}
            onToggle={enabled => toggle(plugin.name, enabled)}
            onUpdate={() => applyUpdates([updateFor(plugin.name)!])}
            onRemove={() => void remove(plugin)} />
        ))}
      </div>

      {detail !== null && detail.builtins.length > 0 && (
        <>
          <div className="section-title">dsh 自带的组合包</div>
          <div className="card list">
            {detail.builtins.map(bundle => (
              <div key={bundle.name} className="list-row">
                <div className="plugin-icon builtin"><Box size={18} /></div>
                <div className="grow">
                  <div className="row wrap">
                    <span className="strong mono">{bundle.name}</span>
                    {bundle.optional ? <span className="badge">可选</span> : <span className="badge accent">核心</span>}
                  </div>
                  <div className="faint ellipsis">{bundle.description}</div>
                </div>
                {bundle.optional
                  ? <Switch on={bundle.enabled} disabled={busy} onChange={enabled => toggle(bundle.name, enabled)} label={`启用 ${bundle.name}`} />
                  : <span className="faint">始终启用</span>}
              </div>
            ))}
          </div>
        </>
      )}
      {creating && <CreateProfile onClose={() => setCreating(false)} onCreated={setProfile} />}
    </div>
  )
}
