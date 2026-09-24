import type { LauncherBridge } from '../../shared/api'
import type {
  AppState, LauncherEvent, LogLine, LogStream, MarketItem, PluginInfo, ProcessStatus, ProfileDetail,
  PluginUpdateCheck, ProfileSummary, SettingsPatch, TaskInfo,
} from '../../shared/types'

/*
 * A simulated backend for `npm run dev:web`, so the UI can be built and reviewed in a
 * plain browser. Package names below are fictional samples, not real registry data.
 */

const now = () => new Date().toISOString()
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const clone = <T>(value: T): T => structuredClone(value)
const HOME = 'C:/Users/you'
const VERSIONS = ['0.1.6-alpha.2', '0.1.6-alpha.1', '0.1.5-rc.2', '0.1.5-rc.1', '0.1.5-alpha.2', '0.1.5-alpha.1', '0.1.3-alpha.2', '0.1.3-alpha.1', '0.1.2-rc.1', '0.1.1-rc.2', '0.1.0-rc.8']

const idle = (): ProcessStatus => ({
  phase: 'stopped', pid: null, profile: null, version: null, port: null, url: null, startedAt: null, exitCode: null,
  error: null, diagnostics: null, failedPlugin: null,
})

const newer = (a: string, b: string | null) => b === null || VERSIONS.indexOf(a) < VERSIONS.indexOf(b)

function sample(name: string, version: string, description: string, weekly: number, days: number, keywords: string[] = []): MarketItem {
  return {
    name,
    version,
    description,
    keywords: ['dsh-plugin', ...keywords],
    date: new Date(Date.now() - days * 86_400_000).toISOString(),
    publisher: 'sample-author',
    npm: `https://www.npmjs.com/package/${name}`,
    repository: null,
    homepage: null,
    weeklyDownloads: weekly,
    official: name.startsWith('@deepseek-ai/'),
    bundle: !name.includes('lib'),
    compat: name.includes('legacy') ? 'warn' : 'ok',
    compatNote: name.includes('legacy') ? '@deepseek-ai/dsh-settings 要求 ^0.1.0-rc.7，当前 dsh 更新' : null,
    deprecated: null,
  }
}

const MARKET: MarketItem[] = [
  sample('dsh-sample-cost-meter', '1.7.30', '示例插件：会话费用统计，显示本会话成本、当日费用与历史记录', 58_210, 1, ['cost', 'usage']),
  sample('dsh-sample-agent-teams', '0.1.20', 'Sample: multi-agent team collaboration with a captain and crew', 23_120, 3, ['multi-agent']),
  sample('dsh-sample-pocket', '2.10.6', '示例插件：手机扫码访问电脑上的 DSH，局域网与公网同屏', 19_876, 2, ['mobile']),
  sample('dsh-sample-memory', '0.5.11', 'Sample: three-tier persistent memory for agents across sessions', 15_430, 6, ['memory']),
  sample('dsh-sample-search', '5.10.3', 'Sample: free web search provider for coding agents', 41_200, 4, ['search']),
  sample('dsh-sample-whale-widget', '0.3.7', '示例插件：Web 界面右下角的余额小鲸鱼挂件', 9_870, 12, ['widget']),
  sample('dsh-sample-skin', '9.16.0', '示例插件：8 套清透冷调主题，一键换肤', 12_110, 9, ['theme']),
  sample('dsh-sample-tui', '2.20.0', 'Sample: a keyboard-first terminal UI for DeepSeek Harness', 7_340, 20, ['tui']),
]

function plugin(name: string, version: string | null, extra: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name, spec: version ? `^${version}` : '^1.0.0', source: 'registry', version, description: '', homepage: null,
    bundle: true, enabled: true, official: name.startsWith('@deepseek-ai/'), compat: 'ok', compatNote: null, ...extra,
  }
}

export function createMockBridge(): LauncherBridge {
  const listeners = new Set<(event: LauncherEvent) => void>()
  const emit = (event: LauncherEvent) => listeners.forEach(listener => listener(event))
  let seq = 0
  let taskSeq = 0
  const logs: LogLine[] = []
  const state: AppState = {
    launcherVersion: '0.1.0',
    platform: 'win32',
    paths: { root: `${HOME}/AppData/Local/dsh-launcher`, dshHome: `${HOME}/.dsh`, logs: `${HOME}/AppData/Local/dsh-launcher/logs` },
    settings: {
      channel: 'latest', activeVersion: '0.1.5-rc.1', pendingVersion: null, autoCheck: true, autoDownload: false, keepVersions: 2,
      mirror: 'npmmirror', customRegistry: '', customNodeMirror: '', proxyMode: 'system', proxyUrl: '', dshHome: '', closeToTray: true, autoStartDsh: false, openAtLogin: false,
      launch: {
        profile: 'web', port: 3080, autoPort: true, openBrowser: true, workspace: `${HOME}/dsh-workspace`, extraArgs: '',
        env: [{ key: 'DEEPSEEK_API_KEY', value: 'sk-sample' }], disableTelemetry: false,
      },
    },
    runtime: { nodeVersion: '24.21.0', pnpmVersion: '11.26.0' },
    installed: [
      { version: '0.1.5-rc.1', installedAt: '2026-09-10T04:02:11.000Z', dir: `${HOME}/AppData/Local/dsh-launcher/versions/0.1.5-rc.1` },
      { version: '0.1.3-alpha.2', installedAt: '2026-09-07T15:40:00.000Z', dir: `${HOME}/AppData/Local/dsh-launcher/versions/0.1.3-alpha.2` },
    ],
    remote: {
      distTags: { latest: '0.1.5-rc.2', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.2' },
      versions: VERSIONS.map((version, index) => ({ version, time: new Date(Date.now() - (index * 2 + 2) * 86_400_000).toISOString() })),
      checkedAt: now(),
    },
    update: null,
    process: idle(),
    tasks: [],
    restartRequired: false,
    launcherUpdate: null,
  }
  const profiles: Record<string, ProfileDetail> = {
    web: {
      name: 'web', dir: `${HOME}/.dsh/profiles/web`, exists: true, pendingBuilds: [],
      builtins: [
        { name: '@deepseek-ai/dsh-base', description: 'Base bundle: models, tools, sessions and settings', enabled: true, optional: false },
        { name: '@deepseek-ai/dsh-web-app', description: 'The browser UI app bundle', enabled: true, optional: false },
        { name: '@deepseek-ai/dsh-experimental-agent-team-profile', description: 'Experimental agent team presets', enabled: false, optional: true },
      ],
      plugins: [
        plugin('@deepseek-ai/dsh-subagent-codex', '0.1.5-rc.1', { spec: '0.1.5-rc.1', description: 'Delegate work to OpenAI Codex as a subagent' }),
        plugin('dsh-sample-cost-meter', '1.7.2', { description: '示例插件：会话费用统计' }),
        plugin('dsh-sample-git-badge', '0.17.4', { spec: 'github:sample/dsh-git-badge', source: 'git', enabled: false, description: 'Sample: git status badges' }),
        plugin('dsh-sample-legacy', '0.2.0', { compat: 'warn', compatNote: '@deepseek-ai/dsh-settings 要求 ^0.1.0-rc.7 || ^0.1.1-rc.2，当前 dsh 为 0.1.5-rc.1', description: 'Sample: an outdated plugin' }),
        plugin('sample-helper-lib', '2.1.0', { bundle: false, enabled: false, description: 'A plain library dependency' }),
      ],
    },
    work: { name: 'work', dir: `${HOME}/.dsh/profiles/work`, exists: true, pendingBuilds: [], builtins: [], plugins: [] },
  }

  const refresh = () => {
    const { channel, activeVersion } = state.settings
    const target = state.remote!.distTags[channel]
    state.update = newer(target, activeVersion) ? target : null
    emit({ type: 'state', state: clone(state) })
  }
  const log = (stream: LogStream, text: string) => {
    const line = { seq: ++seq, time: Date.now(), stream, text }
    logs.push(line)
    emit({ type: 'log', lines: [line] })
  }
  const task = async (title: string, steps = 10, stepMs = 140, failure?: string) => {
    const info: TaskInfo = { id: `mock-${++taskSeq}`, title, status: 'running', progress: 0, detail: '', error: null, startedAt: now(), endedAt: null }
    state.tasks = [info, ...state.tasks].slice(0, 20)
    for (let step = 1; step <= steps; step++) {
      await wait(stepMs)
      info.progress = step / steps
      info.detail = `已完成 ${Math.round(info.progress * 100)}%`
      emit({ type: 'task-log', id: info.id, text: `step ${step}/${steps}\n` })
      refresh()
    }
    info.status = failure === undefined ? 'done' : 'failed'
    info.error = failure ?? null
    info.endedAt = now()
    refresh()
    if (failure !== undefined) throw new Error(failure)
  }
  const changed = (profile: string) => {
    if (state.process.phase === 'running' && state.process.profile === profile) state.restartRequired = true
    emit({ type: 'plugins-changed', profile })
    refresh()
  }
  const detail = (name: string) => profiles[name]
    ?? (profiles[name] = { name, dir: `${HOME}/.dsh/profiles/${name}`, exists: false, pendingBuilds: [], builtins: [], plugins: [] })

  const bridge: LauncherBridge = {
    getState: async () => {
      refresh()
      return clone(state)
    },
    getLogs: async () => logs.slice(),
    clearLogs: async () => {
      logs.length = 0
    },
    getTaskLog: async () => '',
    setup: async () => {
      await task('下载 Node.js 运行时')
      await task(`安装 dsh ${state.remote!.distTags[state.settings.channel]}`)
    },
    checkUpdates: async () => {
      await wait(500)
      state.remote!.checkedAt = now()
      refresh()
    },
    installVersion: async (version, activate) => {
      if (!state.installed.some(item => item.version === version)) {
        await task(`安装 dsh ${version}`, 14)
        state.installed = [{ version, installedAt: now(), dir: `${state.paths.root}/versions/${version}` }, ...state.installed]
          .sort((a, b) => VERSIONS.indexOf(a.version) - VERSIONS.indexOf(b.version))
      }
      if (activate) await bridge.activateVersion(version)
      refresh()
    },
    activateVersion: async (version) => {
      state.settings.activeVersion = version
      if (state.process.phase === 'running') state.restartRequired = true
      refresh()
    },
    removeVersion: async (version) => {
      if (version === state.settings.activeVersion) throw new Error('不能删除正在使用的版本，请先切换到其他版本')
      await task(`删除 dsh ${version}`, 4)
      state.installed = state.installed.filter(item => item.version !== version)
      refresh()
    },
    getReleaseNotes: async (version) => {
      await wait(300)
      return `## dsh ${version}\n\n示例更新日志（模拟数据）。\n\n- 改进插件管理器的安装流程\n- 修复 Web 界面在长会话中的滚动问题\n- 新增实验性的智能体团队预设`
    },
    start: async () => {
      if (state.process.phase === 'running') return
      const { profile, port, workspace } = state.settings.launch
      state.process = { ...idle(), phase: 'starting', pid: 4242, profile, version: state.settings.activeVersion, port, startedAt: now() }
      state.restartRequired = false
      refresh()
      log('system', `启动 dsh ${state.settings.activeVersion}（配置 ${profile}，端口 ${port}，工作区 ${workspace}）`)
      for (const text of ['loading profile layers: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app', `webserver listening on 127.0.0.1:${port}`, 'mounted 142 plugins']) {
        await wait(350)
        log('stdout', text)
      }
      log('stdout', `dsh web: http://127.0.0.1:${port}/?token=***`)
      state.process = { ...state.process, phase: 'running', url: `http://127.0.0.1:${port}/?token=sample` }
      log('system', `dsh 已就绪：http://127.0.0.1:${port}/?token=***`)
      refresh()
    },
    stop: async () => {
      if (state.process.phase !== 'running') return
      state.process = { ...state.process, phase: 'stopping' }
      log('system', '正在停止 dsh…')
      refresh()
      await wait(700)
      state.process = { ...idle(), exitCode: 0 }
      log('system', 'dsh 已停止（退出码 0）')
      refresh()
    },
    restart: async () => {
      await bridge.stop()
      await bridge.start()
    },
    openWebUI: async () => undefined,
    listProfiles: async (): Promise<ProfileSummary[]> => Object.values(profiles).map(item => ({
      name: item.name, exists: item.exists, shipped: item.name === 'web', web: true, plugins: item.plugins.length,
    })),
    createProfile: async (name) => {
      if (profiles[name]) throw new Error(`配置 “${name}” 已存在`)
      await task(`新建配置 ${name}`, 4)
      detail(name).exists = true
      emit({ type: 'plugins-changed', profile: name })
    },
    getProfile: async name => clone(detail(name)),
    checkPluginUpdates: async (name): Promise<PluginUpdateCheck> => {
      await wait(600)
      const targets: Record<string, string> = { 'dsh-sample-cost-meter': '1.7.30', '@deepseek-ai/dsh-subagent-codex': state.settings.activeVersion ?? '' }
      const updates = detail(name).plugins.flatMap(item => (targets[item.name] && targets[item.name] !== item.version
        ? [{ name: item.name, current: item.version, target: targets[item.name], compat: 'ok' as const, compatNote: null }]
        : []))
      const failures = detail(name).plugins.some(item => item.name === 'dsh-sample-legacy')
        ? [{ name: 'dsh-sample-legacy', error: '请求失败（HTTP 404）：registry.npmjs.org' }]
        : []
      return { updates, failures }
    },
    installPlugin: async (name, spec) => {
      if (spec.includes('native')) {
        detail(name).pendingBuilds = ['sample-native-addon']
        changed(name)
        await task(`安装插件 ${spec}`, 12, 140, 'pnpm 拦截了依赖的构建脚本（sample-native-addon）。确认来源可信后，可在插件页“允许构建”并自动重试')
      }
      await task(`安装插件 ${spec}`, 12)
      const base = spec.replace(/^(link|file):/, '').split(/[/\x5c]/).pop() ?? spec
      const pkg = spec.startsWith('@') ? spec.replace(/@[^@/]*$/, '') : base.replace(/@.*$/, '').replace(/\.tgz$/, '')
      detail(name).exists = true
      detail(name).plugins.push(plugin(pkg, '1.0.0', { description: '刚刚安装的插件（模拟）' }))
      changed(name)
    },
    removePlugin: async (name, pkg) => {
      await task(`卸载插件 ${pkg}`, 6)
      detail(name).plugins = detail(name).plugins.filter(item => item.name !== pkg)
      changed(name)
    },
    updatePlugins: async (name, updates) => {
      await task(updates.length === 1 ? `更新插件 ${updates[0].name}` : `更新 ${updates.length} 个插件`, 10)
      for (const update of updates) {
        const item = detail(name).plugins.find(entry => entry.name === update.name)
        if (item) item.version = update.target
      }
      changed(name)
    },
    setBundleEnabled: async (name, pkg, enabled) => {
      const target = detail(name).plugins.find(item => item.name === pkg) ?? detail(name).builtins.find(item => item.name === pkg)
      if (target) target.enabled = enabled
      changed(name)
    },
    decideBuilds: async (name) => {
      detail(name).pendingBuilds = []
      changed(name)
    },
    searchMarket: async (query) => {
      await wait(350)
      const tokens = query.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      let matches = MARKET.filter(item => tokens.every(token => `${item.name} ${item.description} ${item.keywords.join(' ')}`.toLowerCase().includes(token)))
      if (query.bundlesOnly) matches = matches.filter(item => item.bundle === true)
      if (query.hideIncompatible) matches = matches.filter(item => item.compat !== 'warn')
      if (query.sort === 'downloads') matches = [...matches].sort((a, b) => (b.weeklyDownloads ?? 0) - (a.weeklyDownloads ?? 0))
      if (query.sort === 'updated') matches = [...matches].sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''))
      const size = query.size ?? 24
      return {
        items: matches.slice(query.from, query.from + size),
        matched: matches.length,
        indexed: MARKET.length,
        indexedAt: new Date(Date.now() - 42 * 60_000).toISOString(),
        more: matches.length > query.from + size,
        categories: tokens.length === 0
          ? [
            { label: '记忆', query: 'memory', count: 159 },
            { label: '主题美化', query: 'theme', count: 186 },
            { label: '终端 / TUI', query: 'tui', count: 93 },
            { label: 'MCP', query: 'mcp', count: 206 },
          ]
          : [],
        lookup: matches.length === 0 && tokens.length > 0 ? { name: query.query.trim(), state: 'missing' } : null,
      }
    },
    refreshMarketIndex: async () => {
      await task('更新插件索引', 10)
    },
    previewPackage: async (spec) => {
      await wait(400)
      const found = MARKET.find(item => item.name === spec)
      return {
        name: spec, version: found?.version ?? '1.0.0', description: found?.description ?? '', license: 'MIT', homepage: null,
        bundle: !spec.includes('lib'), compat: 'ok', compatNote: null, installScripts: spec.includes('native'), deprecated: null, migrateTo: null,
      }
    },
    checkLauncherUpdate: async () => {
      await wait(500)
      return null
    },
    runDoctor: async () => {
      await wait(900)
      return {
        checkedAt: now(),
        launcherVersion: state.launcherVersion,
        platform: 'win32-x64',
        checks: [
          { id: 'node', title: 'Node.js 运行时', status: 'ok', detail: 'v24.21.0', fix: null },
          { id: 'proxy-env', title: '子进程网络环境', status: 'ok', detail: '代理与下载源变量正常', fix: null },
          { id: 'pnpm', title: 'pnpm', status: 'ok', detail: '11.26.0，使用下载源 https://registry.npmmirror.com/', fix: null },
          { id: 'dsh', title: 'dsh', status: 'ok', detail: `${state.settings.activeVersion}（latest 通道）`, fix: null },
          { id: 'registry', title: '下载源', status: 'ok', detail: 'https://registry.npmmirror.com 响应 132 ms', fix: null },
          { id: 'dsh-home', title: 'DSH_HOME', status: 'ok', detail: `${HOME}/.dsh`, fix: null },
          { id: 'workspace', title: '工作区', status: 'ok', detail: `${HOME}/dsh-workspace`, fix: null },
          { id: 'port', title: '启动端口', status: 'ok', detail: '3080 空闲', fix: null },
          { id: 'profile', title: '启动配置', status: 'ok', detail: 'web（5 个插件）', fix: null },
          { id: 'builds', title: '构建脚本', status: 'ok', detail: '没有待决定的构建脚本', fix: null },
          { id: 'plugins', title: '插件状态', status: 'warn', detail: '声明的版本范围不含当前 dsh：dsh-sample-legacy', fix: 'plugins' },
        ],
      }
    },
    testMirrors: async () => {
      await wait(700)
      return [
        { mirror: 'npmmirror', label: 'npmmirror 国内镜像', registry: 'https://registry.npmmirror.com', ms: 132, error: null },
        { mirror: 'official', label: '官方源（npmjs.org / nodejs.org）', registry: 'https://registry.npmjs.org', ms: 684, error: null },
      ]
    },
    exportPlugins: async name => `${HOME}/Downloads/dsh-plugins-${name}.json`,
    importPlugins: async (name) => {
      await task('安装 2 个插件', 10)
      detail(name).plugins.push(plugin('dsh-sample-memory', '0.5.11'), plugin('dsh-sample-search', '5.10.3'))
      changed(name)
      return { requested: 3, installed: ['dsh-sample-memory', 'dsh-sample-search'], skipped: [{ name: 'dsh-local-tool', reason: '本地目录在这台电脑上不存在' }] }
    },
    updateSettings: async (patch: SettingsPatch) => {
      state.settings = { ...state.settings, ...patch, launch: { ...state.settings.launch, ...patch.launch } }
      refresh()
    },
    cancelTask: async () => undefined,
    pickDirectory: async () => 'D:/Projects/my-app',
    pickFile: async () => 'D:/Downloads/dsh-sample-plugin-0.1.0.tgz',
    openPath: async () => undefined,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return bridge
}
