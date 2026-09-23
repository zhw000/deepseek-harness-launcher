import { Eye, EyeOff, FolderOpen, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { EnvVar, MirrorId, ProxyMode, SettingsPatch } from '../../../shared/types'
import { api } from '../api'
import { CommitInput, Field, Segmented, Switch } from '../components/ui'
import { MIRROR_LABELS } from '../format'
import { attempt, useAppState } from '../store'

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const save = (patch: SettingsPatch, message?: string) => void attempt(() => api.updateSettings(patch), message)

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="card card-pad section">
      <div className="card-title">{title}</div>
      {description && <p className="card-sub">{description}</p>}
      {children}
    </div>
  )
}

function ToggleRow({ title, hint, on, onChange }: { title: string; hint: ReactNode; on: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="row" style={{ padding: '6px 0' }}>
      <div className="grow">
        <div>{title}</div>
        <div className="faint">{hint}</div>
      </div>
      <Switch on={on} onChange={onChange} label={title} />
    </div>
  )
}

function EnvEditor({ env }: { env: EnvVar[] }) {
  const [rows, setRows] = useState<EnvVar[]>(env)
  const [reveal, setReveal] = useState(false)
  useEffect(() => setRows(env), [env])
  const dirty = JSON.stringify(rows) !== JSON.stringify(env)
  const invalid = rows.some(row => row.key !== '' && !ENV_KEY.test(row.key))
  const update = (index: number, patch: Partial<EnvVar>) => setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  return (
    <div className="stack">
      {rows.length === 0 && <div className="faint">没有额外的环境变量。</div>}
      {rows.map((row, index) => (
        <div key={index} className="row">
          <input className="input mono" style={{ width: 240 }} value={row.key} placeholder="名称，如 DEEPSEEK_API_KEY" spellCheck={false}
            onChange={event => update(index, { key: event.target.value.trim() })} />
          <input className="input mono grow" type={reveal ? 'text' : 'password'} value={row.value} placeholder="值" spellCheck={false}
            onChange={event => update(index, { value: event.target.value })} />
          <button type="button" className="btn ghost sm icon danger" title="删除" onClick={() => setRows(rows.filter((_, i) => i !== index))}><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="row">
        <button type="button" className="btn sm" onClick={() => setRows([...rows, { key: '', value: '' }])}><Plus size={14} />添加变量</button>
        <button type="button" className="btn ghost sm" onClick={() => setReveal(!reveal)}>{reveal ? <EyeOff size={14} /> : <Eye size={14} />}{reveal ? '隐藏值' : '显示值'}</button>
        <span className="grow" />
        {invalid && <span className="faint bad">变量名只能包含字母、数字和下划线，且不能以数字开头</span>}
        {dirty && <button type="button" className="btn sm" onClick={() => setRows(env)}>撤销</button>}
        <button type="button" className="btn sm primary" disabled={!dirty || invalid} onClick={() => save({ launch: { env: rows.filter(row => row.key !== '') } }, '环境变量已保存')}>保存</button>
      </div>
    </div>
  )
}

const MIRROR_OPTIONS: Array<{ value: MirrorId; hint: string }> = [
  { value: 'npmmirror', hint: '国内访问更快，与 npm 同步通常有几分钟延迟' },
  { value: 'official', hint: 'registry.npmjs.org 与 nodejs.org，总是最新' },
  { value: 'custom', hint: '公司内部仓库或其他镜像' },
]

export function SettingsPage() {
  const { settings, paths, launcherVersion, platform } = useAppState()
  const launch = settings.launch
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-sub">修改会立即保存。影响 dsh 运行环境的修改在重启 dsh 后生效。</p>
        </div>
      </div>

      <Section title="下载源" description="用于下载 Node.js、pnpm、dsh 和插件。插件市场的搜索始终使用 npmjs.org。">
        <div className="stack">
          {MIRROR_OPTIONS.map(option => (
            <label key={option.value} className="row radio-row">
              <input type="radio" name="mirror" checked={settings.mirror === option.value} onChange={() => save({ mirror: option.value })} />
              <div className="grow">
                <div>{MIRROR_LABELS[option.value]}</div>
                <div className="faint">{option.hint}</div>
              </div>
            </label>
          ))}
          {settings.mirror === 'custom' && (
            <div className="grid-2">
              <Field label="npm registry">
                <CommitInput className="input mono" value={settings.customRegistry} placeholder="https://registry.example.com" onCommit={customRegistry => save({ customRegistry })} />
              </Field>
              <Field label="Node.js 下载地址" hint="包含 index.json 的目录；留空使用 nodejs.org">
                <CommitInput className="input mono" value={settings.customNodeMirror} placeholder="https://example.com/mirrors/node" onCommit={customNodeMirror => save({ customNodeMirror })} />
              </Field>
            </div>
          )}
        </div>
      </Section>

      <Section title="网络代理" description="用于启动器自己的下载，也会以 HTTP_PROXY / HTTPS_PROXY 传给 npm、pnpm 和 dsh。本机地址总是直连。">
        <div className="row wrap">
          <Segmented<ProxyMode> value={settings.proxyMode} onChange={proxyMode => save({ proxyMode })}
            options={[{ value: 'system', label: '跟随系统' }, { value: 'none', label: '不使用代理' }, { value: 'custom', label: '自定义' }]} />
          {settings.proxyMode === 'custom' && (
            <CommitInput className="input mono grow" value={settings.proxyUrl} placeholder="http://127.0.0.1:7890" onCommit={proxyUrl => save({ proxyUrl })} />
          )}
        </div>
      </Section>

      <Section title="启动选项">
        <ToggleRow title="端口被占用时自动换一个" hint={`首选端口 ${launch.port} 被占用时，使用后面第一个空闲端口`} on={launch.autoPort} onChange={autoPort => save({ launch: { autoPort } })} />
        <ToggleRow title="关闭窗口时最小化到托盘" hint="dsh 运行时关闭窗口不会退出，可从托盘图标打开或退出" on={settings.closeToTray} onChange={closeToTray => save({ closeToTray })} />
        <ToggleRow title="关闭 OpenTelemetry 反馈上报" hint={<>设置 <code>DSH_TELEMETRY_MODE=DISABLED</code>。dsh 发给 DeepSeek 的会话日志另由其配置项控制</>}
          on={launch.disableTelemetry} onChange={disableTelemetry => save({ launch: { disableTelemetry } })} />
        <div className="divider" />
        <Field label="额外参数" hint={<>追加在 <code>dsh --profile {launch.profile} --no-open --port {launch.port}</code> 之后，例如 <code>--trusted-host my.host</code>；<code>--patch 文件</code> 会自动移到应用参数之前。</>}>
          <CommitInput className="input mono" value={launch.extraArgs} placeholder="--trusted-host my.host" onCommit={extraArgs => save({ launch: { extraArgs } })} />
        </Field>
      </Section>

      <Section title="环境变量" description="注入 dsh 进程，例如 DEEPSEEK_API_KEY。值用系统凭据加密后保存；模型密钥也可以在 dsh Web 界面的“设置 → 模型”中配置。">
        <EnvEditor env={launch.env} />
      </Section>

      <Section title="路径">
        <div className="stack">
          <Field label="DSH_HOME（会话、设置、凭据与配置所在目录）" hint="留空时与 dsh 相同：先看 DSH_HOME 环境变量，否则使用 ~/.dsh">
            <div className="row">
              <CommitInput className="input mono grow" value={settings.dshHome} placeholder={paths.dshHome} onCommit={dshHome => save({ dshHome })} />
              <button type="button" className="btn" onClick={() => void attempt(async () => {
                const picked = await api.pickDirectory(paths.dshHome)
                if (picked) await api.updateSettings({ dshHome: picked })
              })}>选择</button>
              {settings.dshHome !== '' && <button type="button" className="btn icon" title="恢复默认" onClick={() => save({ dshHome: '' })}><RotateCcw size={15} /></button>}
              <button type="button" className="btn icon" title="打开" onClick={() => void attempt(() => api.openPath('dshHome'))}><FolderOpen size={15} /></button>
            </div>
          </Field>
          <Field label="启动器数据目录（Node.js、pnpm、各版本 dsh 与日志）" hint="设置环境变量 DSH_LAUNCHER_DATA，或在程序旁放一个名为 portable 的文件，可改为便携模式">
            <div className="row">
              <input className="input mono grow" value={paths.root} readOnly />
              <button type="button" className="btn icon" title="打开" onClick={() => void attempt(() => api.openPath('root'))}><FolderOpen size={15} /></button>
            </div>
          </Field>
        </div>
      </Section>

      <Section title="关于">
        <dl className="kv">
          <dt>启动器版本</dt><dd className="mono">{launcherVersion}</dd>
          <dt>平台</dt><dd className="mono">{platform}</dd>
          <dt>DeepSeek Harness</dt>
          <dd><a onClick={() => void attempt(() => api.openExternal('https://github.com/deepseek-ai/deepseek-harness'))}>github.com/deepseek-ai/deepseek-harness</a></dd>
        </dl>
      </Section>
    </div>
  )
}
