import { CircleArrowUp, HeartPulse, Layers, Puzzle, Rocket, Settings, Store } from 'lucide-react'
import { useEffect, type ComponentType } from 'react'
import { api, isMock } from './api'
import { TaskDock } from './components/TaskDock'
import { ConfirmHost, Spinner, Toasts } from './components/ui'
import { PHASES } from './format'
import { DoctorPage } from './pages/DoctorPage'
import { HomePage } from './pages/HomePage'
import { MarketPage } from './pages/MarketPage'
import { PluginsPage } from './pages/PluginsPage'
import { SettingsPage } from './pages/SettingsPage'
import { VersionsPage } from './pages/VersionsPage'
import { attempt, store, useRoute, useStore, type Route } from './store'

const NAV: Array<{ route: Route; label: string; icon: ComponentType<{ size?: number }>; page: ComponentType }> = [
  { route: 'home', label: '启动', icon: Rocket, page: HomePage },
  { route: 'versions', label: '版本', icon: Layers, page: VersionsPage },
  { route: 'plugins', label: '插件', icon: Puzzle, page: PluginsPage },
  { route: 'market', label: '插件市场', icon: Store, page: MarketPage },
  { route: 'doctor', label: '体检', icon: HeartPulse, page: DoctorPage },
  { route: 'settings', label: '设置', icon: Settings, page: SettingsPage },
]

export function App() {
  const state = useStore(current => current.state)
  const [route, go] = useRoute()
  useEffect(() => store.start(), [])

  if (state === null) {
    return <div className="boot"><span className="row"><Spinner />正在加载…</span></div>
  }

  const Page = NAV.find(item => item.route === route)!.page
  const { phase } = state.process
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Rocket size={18} /></div>
          <div>
            <div className="brand-name">DSH Launcher</div>
            <div className="brand-sub">DeepSeek Harness</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map(({ route: target, label, icon: Icon }) => (
            <button key={target} type="button" className={`nav-item${route === target ? ' active' : ''}`} onClick={() => go(target)}>
              <Icon size={17} />
              {label}
              {target === 'versions' && state.update !== null && state.settings.pendingVersion === null && <span className="count">新</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-status">
            <span className={`dot ${phase}`} />
            dsh {PHASES[phase]}
            {state.process.port !== null && phase === 'running' && <span className="faint mono">:{state.process.port}</span>}
          </div>
          {state.launcherUpdate !== null && (
            <button type="button" className="sidebar-update" onClick={() => void attempt(() => api.openExternal(state.launcherUpdate!.url))}>
              <CircleArrowUp size={14} />启动器 v{state.launcherUpdate.version} 可更新
            </button>
          )}
          <div className="sidebar-version">
            启动器 v{state.launcherVersion}{isMock && ' · 演示数据'}
          </div>
        </div>
      </aside>
      <main className="main" key={route}>
        <Page />
      </main>
      <TaskDock />
      <Toasts />
      <ConfirmHost />
    </div>
  )
}
