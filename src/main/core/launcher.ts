import { EventEmitter } from 'node:events'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AppState, LauncherEvent, LogLine, MarketPage, NoticeLevel, PackagePreview, PluginUpdate, PluginUpdateCheck,
  CheckFix, CheckStatus, DoctorCheck, DoctorReport, ImportResult, LauncherRelease, MarketQuery, MirrorTiming, PluginExport, ProfileDetail, ProfileSummary, RemoteInfo, Settings, SettingsPatch,
} from '../../shared/types'
import {
  cleanupVersionsRoot, DSH_PACKAGE, dshBinPath, installDsh, listInstalled, newerOnChannel, pruneCandidates, removeDsh,
  toRemoteInfo, type DshInstall,
} from './dsh-versions'
import { getJson, HttpError, type FetchFn } from './http'
import { RELEASES_API, resolveEndpoints, type Endpoints } from './mirrors'
import { DSH_NODE_RANGE, findInstalledNode, installNode, nodeBinDir, type NodeRuntime } from './node-runtime'
import { launcherPaths, profileDir, resolveDshHome, type LauncherPaths } from './paths'
import { MarketService } from './market'
import { fetchLatestLauncherRelease, newerLauncher } from './self-update'
import { emptyProxyVariables, latencyStatus, measureRegistry, mirrorCandidates } from './doctor'
import { buildPluginExport, parsePluginList, restoreSpec } from './plugin-list'
import {
  addCommands, explainPnpmFailure, findPluginUpdates, isBuildBlocked, planInstall, planUpdates, pnpmProgress, previewPackage,
  type InstallPlan,
} from './plugins'
import { installedPnpmVersion, installPnpm, pnpmCliPath, PNPM_SPEC, writeShims } from './pnpm'
import { childEnvironment } from './environment'
import { appendPath, prependPath, run } from './proc'
import {
  decideBuilds, installationBundles, listProfiles, readPendingBuilds, readProfileDetail, setBundleEnabled,
  validateProfileName, type InstallationBundle,
} from './profiles'
import { fetchPackument } from './registry'
import { applySettingsPatch, defaultSettings, loadSettings, saveSettings, type SecretCodec } from './settings'
import { DshSupervisor, ensureBridge, findFreePort, isPortFree, splitLaunchArgs } from './supervisor'
import { TaskRunner, type TaskHandle } from './tasks'
import { ensureDir, errorMessage, pathExists, splitArgs } from './util'

/** What differs between the Electron app and tests. */
export interface PlatformHooks {
  fetch: FetchFn
  /** Point the launcher's own network stack at the configured proxy. */
  applyProxy(settings: Settings): Promise<void>
  /** Proxy URL for child processes; null forces direct, undefined keeps the inherited environment. */
  childProxy(settings: Settings): Promise<string | null | undefined>
  openExternal(url: string): Promise<void>
  codec?: SecretCodec
  locale?: string
  /** Register or remove the launcher as an OS login item. Unpackaged builds may ignore it. */
  applyLoginItem?(enabled: boolean): void
}

export interface LauncherOptions {
  root: string
  launcherVersion: string
  hooks: PlatformHooks
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  home?: string
}

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const KEEP_RUN_LOGS = 20

type ServiceEvents = { event: [LauncherEvent] }

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Create the folder if needed and prove a file can be written there. */
async function writableDir(dir: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await ensureDir(dir)
    const probe = join(dir, `.dsh-launcher-probe-${process.pid}`)
    await writeFile(probe, 'ok')
    await rm(probe, { force: true })
    return { ok: true, detail: dir }
  } catch (error) {
    return { ok: false, detail: `${dir} 无法写入：${errorMessage(error)}` }
  }
}

function lastLine(output: string): string {
  return output.trim().split(/\r?\n/).pop()?.trim() ?? ''
}

/** Everything the launcher does, independent of Electron. */
export class LauncherService extends EventEmitter<ServiceEvents> {
  readonly paths: LauncherPaths
  private readonly hooks: PlatformHooks
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly home: string
  private readonly defaults: Settings
  private settings: Settings
  private node: NodeRuntime | null = null
  private pnpmVersion: string | null = null
  private installed: DshInstall[] = []
  private remote: RemoteInfo | null = null
  private restartRequired = false
  private launcherUpdate: LauncherRelease | null = null
  private notifiedVersion: string | null = null
  private readonly market: MarketService
  private readonly tasks = new TaskRunner()
  private readonly supervisor = new DshSupervisor()
  private readonly bundleCache = new Map<string, Promise<InstallationBundle[]>>()
  private readonly releaseNotes = new Map<string, string | null>()
  /** Last install pnpm blocked on build scripts, retried once they are approved. */
  private readonly blockedInstalls = new Map<string, { title: string; args: string[] }>()
  /** Install requests waiting to join the next pnpm run for a profile. */
  private readonly installBatches = new Map<string, { plans: InstallPlan[]; waiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }>; running: boolean }>()
  private setupRun: Promise<void> | null = null
  private startRun: Promise<void> | null = null
  private stateTimer: NodeJS.Timeout | null = null
  private updateTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: LauncherOptions) {
    super()
    this.paths = launcherPaths(options.root)
    this.hooks = options.hooks
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.home = options.home ?? homedir()
    this.defaults = defaultSettings(this.home, options.hooks.locale)
    this.settings = this.defaults
    this.market = new MarketService({
      fetch: this.hooks.fetch,
      registry: () => this.endpoints.registry,
      cacheDir: this.paths.cache,
      dshVersion: () => this.active?.version ?? null,
    })
    this.tasks.on('change', () => this.scheduleState())
    this.tasks.on('log', (id, text) => this.send({ type: 'task-log', id, text }))
    this.supervisor.on('status', () => this.scheduleState())
    this.supervisor.on('lines', lines => this.send({ type: 'log', lines }))
  }

  async init(): Promise<void> {
    await ensureDir(this.paths.root)
    this.settings = await loadSettings(this.paths.settings, this.defaults, this.hooks.codec)
    await this.hooks.applyProxy(this.settings)
    await cleanupVersionsRoot(this.paths.versions)
    await this.refreshLocal()
    this.hooks.applyLoginItem?.(this.settings.openAtLogin)
    this.scheduleUpdateChecks()
  }

  async dispose(): Promise<void> {
    if (this.updateTimer !== null) clearInterval(this.updateTimer)
    if (this.stateTimer !== null) clearTimeout(this.stateTimer)
    await this.supervisor.stop()
  }

  get isRunning(): boolean {
    return this.supervisor.running
  }

  get currentSettings(): Settings {
    return this.settings
  }

  get dshHome(): string {
    return resolveDshHome(this.settings.dshHome, this.env, this.home)
  }

  profileDir(name: string): string {
    return profileDir(this.dshHome, name)
  }

  private get endpoints(): Endpoints {
    return resolveEndpoints(this.settings)
  }

  private get active(): DshInstall | null {
    return this.installed.find(install => install.version === this.settings.activeVersion) ?? null
  }

  getState(): AppState {
    return {
      launcherVersion: this.options.launcherVersion,
      platform: this.platform,
      paths: { root: this.paths.root, dshHome: this.dshHome, logs: this.paths.logs },
      settings: this.settings,
      runtime: { nodeVersion: this.node?.version ?? null, pnpmVersion: this.pnpmVersion },
      installed: this.installed.map(({ version, dir, installedAt }) => ({ version, dir, installedAt })),
      remote: this.remote,
      update: newerOnChannel(this.remote, this.settings.channel, this.settings.activeVersion),
      process: this.supervisor.status,
      tasks: this.tasks.list(),
      restartRequired: this.restartRequired,
      launcherUpdate: this.launcherUpdate,
    }
  }

  notice(level: NoticeLevel, message: string): void {
    this.send({ type: 'notice', level, message })
  }

  private send(event: LauncherEvent): void {
    this.emit('event', event)
  }

  private scheduleState(): void {
    if (this.stateTimer !== null) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.send({ type: 'state', state: this.getState() })
    }, 50)
  }

  private async save(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch }
    await saveSettings(this.paths.settings, this.settings, this.hooks.codec)
    this.scheduleState()
  }

  // ---- environment ----

  /** Environment every child shares: DSH_HOME, the chosen registry and the proxy. */
  private async childEnv(): Promise<NodeJS.ProcessEnv> {
    return childEnvironment(this.env, this.settings, this.dshHome, await this.hooks.childProxy(this.settings), this.platform)
  }

  /** For npm, pnpm and `dsh plugin`: managed Node and pnpm take precedence. */
  private async toolEnv(runtime: NodeRuntime): Promise<NodeJS.ProcessEnv> {
    return prependPath(await this.childEnv(), [nodeBinDir(runtime), this.paths.bin])
  }

  /**
   * For the dsh process: managed pnpm first so the Web plugin page works even
   * without a global pnpm, managed Node last so agent shells keep the user's own Node.
   */
  private async dshEnv(runtime: NodeRuntime): Promise<NodeJS.ProcessEnv> {
    const env = appendPath(prependPath(await this.childEnv(), [this.paths.bin]), [nodeBinDir(runtime)])
    const launch = this.settings.launch
    if (launch.disableTelemetry) env.DSH_TELEMETRY_MODE = 'DISABLED'
    for (const { key, value } of launch.env) env[key] = value
    return env
  }

  // ---- runtime and versions ----

  private async refreshLocal(): Promise<void> {
    this.node = await findInstalledNode(this.paths.node, this.platform, DSH_NODE_RANGE)
    this.pnpmVersion = await installedPnpmVersion(this.paths)
    this.installed = await listInstalled(this.paths.versions)
    const has = (version: string | null) => version !== null && this.installed.some(install => install.version === version)
    const { activeVersion, pendingVersion } = this.settings
    if (!has(activeVersion) || (pendingVersion !== null && !has(pendingVersion))) {
      // A version folder was deleted by hand; fall back to the newest one left.
      await this.save({
        activeVersion: has(activeVersion) ? activeVersion : this.installed[0]?.version ?? null,
        pendingVersion: has(pendingVersion) ? pendingVersion : null,
      })
    }
    this.scheduleState()
  }

  /** Download whatever is missing. Concurrent callers share one run. */
  setup(): Promise<void> {
    this.setupRun ??= this.runSetup().finally(() => {
      this.setupRun = null
    })
    return this.setupRun
  }

  private async runSetup(): Promise<void> {
    const runtime = await this.ensureNode()
    await this.ensurePnpm(runtime)
    if (this.active === null) {
      const remote = await this.fetchRemote()
      const version = remote.distTags[this.settings.channel] ?? remote.distTags.latest
      if (version === undefined) throw new Error(`通道 ${this.settings.channel} 没有可用的 dsh 版本`)
      await this.installVersionTask(version)
      await this.save({ activeVersion: version })
    }
  }

  private async ensureNode(): Promise<NodeRuntime> {
    if (this.node !== null && await pathExists(this.node.node)) return this.node
    return this.tasks.run('下载 Node.js 运行时', async (task) => {
      const found = await findInstalledNode(this.paths.node, this.platform, DSH_NODE_RANGE)
      this.node = found ?? await installNode({
        fetch: this.hooks.fetch, nodeDist: this.endpoints.nodeDist, paths: this.paths,
        platform: this.platform, arch: this.arch, signal: task.signal, progress: task.progress, log: task.log,
      })
      this.scheduleState()
      return this.node
    })
  }

  private async ensurePnpm(runtime: NodeRuntime): Promise<void> {
    if (this.pnpmVersion === null) {
      await this.tasks.run('安装 pnpm', async (task) => {
        task.progress(null, `npm install ${PNPM_SPEC}`)
        this.pnpmVersion = await installedPnpmVersion(this.paths) ?? await installPnpm({
          runtime, paths: this.paths, registry: this.endpoints.registry, env: await this.toolEnv(runtime),
          signal: task.signal, log: task.log,
        })
        this.scheduleState()
      })
    }
    await writeShims(this.paths, runtime, this.platform)
  }

  private async fetchRemote(): Promise<RemoteInfo> {
    const packument = await fetchPackument(this.hooks.fetch, this.endpoints.registry, DSH_PACKAGE, { full: true })
    this.remote = toRemoteInfo(packument)
    this.scheduleState()
    return this.remote
  }

  private async installVersionTask(version: string): Promise<void> {
    if (this.installed.some(install => install.version === version)) return
    const runtime = await this.ensureNode()
    await this.tasks.run(`安装 dsh ${version}`, async (task) => {
      let fetched = 0
      task.progress(null, '正在解析依赖')
      await installDsh({
        runtime, paths: this.paths, registry: this.endpoints.registry, version,
        env: await this.toolEnv(runtime), signal: task.signal,
        log: (text) => {
          task.log(text)
          const hits = text.match(/http fetch GET 200/g)?.length ?? 0
          if (hits > 0) {
            fetched += hits
            task.progress(null, `正在下载依赖（已获取 ${fetched} 个包）`)
          }
        },
      })
      this.installed = await listInstalled(this.paths.versions)
      this.scheduleState()
    })
  }

  private scheduleUpdateChecks(): void {
    if (this.updateTimer !== null) clearInterval(this.updateTimer)
    this.updateTimer = null
    if (!this.settings.autoCheck) return
    void this.backgroundCheck()
    this.updateTimer = setInterval(() => void this.backgroundCheck(), UPDATE_INTERVAL_MS)
    this.updateTimer.unref?.()
  }

  private async backgroundCheck(): Promise<void> {
    // GitHub can be slow or unreachable from some networks; it must never hold up the dsh check.
    void this.checkLauncherUpdate().catch(() => undefined)
    try {
      await this.checkUpdates()
    } catch {
      // Offline: the Versions page keeps the last result.
      return
    }
    const target = newerOnChannel(this.remote, this.settings.channel, this.settings.pendingVersion ?? this.settings.activeVersion)
    if (target === null || this.active === null || this.notifiedVersion === target) return
    this.notifiedVersion = target
    if (this.settings.autoDownload) await this.autoUpdate(target)
    else this.notice('info', `发现 dsh 新版本 ${target}，可在“版本”页更新`)
  }

  /** Look for a newer launcher release on GitHub; the sidebar offers it once found. */
  async checkLauncherUpdate(): Promise<LauncherRelease | null> {
    const release = await fetchLatestLauncherRelease(this.hooks.fetch)
    const newer = newerLauncher(this.options.launcherVersion, release)
    if (newer !== null && this.launcherUpdate?.version !== newer.version) {
      this.notice('info', `启动器有新版本 v${newer.version}，可在左下角查看`)
    }
    this.launcherUpdate = newer
    this.scheduleState()
    return newer
  }

  private async autoUpdate(version: string): Promise<void> {
    try {
      await this.installVersionTask(version)
      if (this.supervisor.running) {
        await this.save({ pendingVersion: version })
        this.notice('success', `dsh ${version} 已下载，下次启动时自动切换`)
      } else {
        await this.save({ activeVersion: version, pendingVersion: null })
        this.notice('success', `dsh 已自动更新到 ${version}`)
      }
      await this.pruneVersions()
    } catch (error) {
      this.notice('error', `自动更新失败：${errorMessage(error)}`)
    }
  }

  async checkUpdates(): Promise<void> {
    await this.fetchRemote()
  }

  async installVersion(version: string, activate: boolean): Promise<void> {
    await this.installVersionTask(version)
    if (activate) {
      await this.activateVersion(version)
      await this.pruneVersions()
    }
  }

  async activateVersion(version: string): Promise<void> {
    if (!this.installed.some(install => install.version === version)) throw new Error(`dsh ${version} 尚未安装`)
    const pending = this.settings.pendingVersion === version ? null : this.settings.pendingVersion
    await this.save({ activeVersion: version, pendingVersion: pending })
    if (this.supervisor.running && this.supervisor.status.version !== version) this.restartRequired = true
    this.scheduleState()
  }

  async removeVersion(version: string): Promise<void> {
    if (version === this.settings.activeVersion) throw new Error('不能删除正在使用的版本，请先切换到其他版本')
    if (this.supervisor.running && this.supervisor.status.version === version) throw new Error('该版本正在运行')
    await this.tasks.run(`删除 dsh ${version}`, async () => {
      await removeDsh(this.paths, version)
      this.installed = await listInstalled(this.paths.versions)
    })
    if (this.settings.pendingVersion === version) await this.save({ pendingVersion: null })
    this.scheduleState()
  }

  private async pruneVersions(): Promise<void> {
    const protect = [this.settings.activeVersion, this.settings.pendingVersion, this.supervisor.status.version]
    const victims = pruneCandidates(this.installed.map(install => install.version), this.settings.keepVersions, protect)
    if (victims.length === 0) return
    await this.tasks.run(`清理旧版本 ${victims.join('、')}`, async () => {
      for (const version of victims) await removeDsh(this.paths, version)
      this.installed = await listInstalled(this.paths.versions)
    })
  }

  async getReleaseNotes(version: string): Promise<string | null> {
    const cached = this.releaseNotes.get(version)
    if (cached !== undefined) return cached
    try {
      const release = await getJson<{ body?: string | null }>(this.hooks.fetch, `${RELEASES_API}/tags/dsh-v${encodeURIComponent(version)}`, {
        headers: { accept: 'application/vnd.github+json' }, attempts: 1, timeoutMs: 15_000,
      })
      const body = release.body?.trim() || null
      this.releaseNotes.set(version, body)
      return body
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        this.releaseNotes.set(version, null)
        return null
      }
      throw error
    }
  }

  // ---- process ----

  start(): Promise<void> {
    this.startRun ??= this.runStart().finally(() => {
      this.startRun = null
    })
    return this.startRun
  }

  private async runStart(): Promise<void> {
    if (this.supervisor.running) return
    await this.setup()
    const pending = this.settings.pendingVersion
    if (pending !== null && this.installed.some(install => install.version === pending)) {
      await this.save({ activeVersion: pending, pendingVersion: null })
      this.supervisor.note(`切换到已下载的新版本 ${pending}`)
    }
    const install = this.active
    const runtime = this.node
    if (install === null || runtime === null) throw new Error('dsh 尚未安装')
    const launch = this.settings.launch
    const profile = (await listProfiles(this.dshHome)).find(item => item.name === launch.profile)
    if (profile === undefined) throw new Error(`找不到配置 “${launch.profile}”`)
    if (!profile.web) throw new Error(`配置 “${launch.profile}” 不含 Web 界面，启动器只能启动 Web 配置`)
    let port = launch.port
    if (!await isPortFree(port)) {
      const free = launch.autoPort ? await findFreePort(port + 1) : null
      if (free === null) throw new Error(`端口 ${port} 已被占用${launch.autoPort ? '，附近也没有空闲端口' : ''}`)
      this.supervisor.note(`端口 ${port} 已被占用，改用 ${free}`)
      port = free
    }
    const { launcherArgs, appArgs } = splitLaunchArgs(splitArgs(launch.extraArgs))
    await ensureDir(launch.workspace)
    await ensureDir(this.paths.logs)
    await this.pruneRunLogs()
    this.restartRequired = false
    await this.supervisor.start({
      node: runtime.node,
      dshBin: await dshBinPath(install.dir),
      bridge: await ensureBridge(this.paths.bin),
      profile: launch.profile,
      version: install.version,
      port,
      cwd: launch.workspace,
      env: await this.dshEnv(runtime),
      launcherArgs,
      appArgs,
      logFile: join(this.paths.logs, `dsh-${timestamp()}.log`),
    })
    const url = this.supervisor.status.url
    if (launch.openBrowser && url !== null) await this.hooks.openExternal(url)
  }

  async stop(): Promise<void> {
    await this.supervisor.stop()
    this.restartRequired = false
    this.scheduleState()
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async openWebUI(): Promise<void> {
    const url = this.supervisor.status.url
    if (url === null) throw new Error('dsh 没有在运行')
    await this.hooks.openExternal(url)
  }

  getLogs(): LogLine[] {
    return this.supervisor.getLines()
  }

  clearLogs(): void {
    this.supervisor.clearLines()
  }

  getTaskLog(id: string): string {
    return this.tasks.logOf(id)
  }

  cancelTask(id: string): void {
    this.tasks.cancel(id)
  }

  private async pruneRunLogs(): Promise<void> {
    const names = (await readdir(this.paths.logs).catch(() => [] as string[]))
      .filter(name => /^dsh-.+\.log$/.test(name))
      .sort()
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_RUN_LOGS))) {
      await rm(join(this.paths.logs, name), { force: true }).catch(() => undefined)
    }
  }

  // ---- profiles and plugins ----

  listProfiles(): Promise<ProfileSummary[]> {
    return listProfiles(this.dshHome)
  }

  private async ready(): Promise<{ runtime: NodeRuntime; install: DshInstall }> {
    await this.setup()
    const runtime = this.node
    const install = this.active
    if (runtime === null || install === null) throw new Error('dsh 尚未安装')
    return { runtime, install }
  }

  async createProfile(name: string): Promise<void> {
    const trimmed = name.trim()
    const problem = validateProfileName(trimmed)
    if (problem !== null) throw new Error(problem)
    if ((await listProfiles(this.dshHome)).some(profile => profile.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error(`配置 “${trimmed}” 已存在`)
    }
    const { runtime, install } = await this.ready()
    const dshBin = await dshBinPath(install.dir)
    await this.tasks.run(`新建配置 ${trimmed}`, async (task) => {
      // A config dump initializes the profile from the shipped web template without booting it.
      const result = await run(runtime.node, [dshBin, '--profile', trimmed, '--from-default-profile', 'web', '--dump-default-config'], {
        cwd: this.paths.root, env: await this.toolEnv(runtime), signal: task.signal,
        onOutput: (text, stream) => {
          if (stream === 'stderr') task.log(text)
        },
      })
      if (result.code !== 0) throw new Error(`dsh 创建配置失败：${lastLine(result.output)}`)
    })
    this.send({ type: 'plugins-changed', profile: trimmed })
  }

  async getProfile(name: string): Promise<ProfileDetail> {
    const install = this.active
    return readProfileDetail(this.dshHome, name, {
      dshVersion: install?.version ?? null,
      installation: install === null ? [] : await this.installationBundles(install),
    })
  }

  private installationBundles(install: DshInstall): Promise<InstallationBundle[]> {
    let cached = this.bundleCache.get(install.dir)
    if (cached === undefined) {
      cached = installationBundles(install.dir).catch(() => [])
      this.bundleCache.set(install.dir, cached)
    }
    return cached
  }
  /**
   * Run `dsh plugin --profile <profile>` commands in one task, so pnpm reconciles bundles exactly
   * as dsh does. `build` runs when the task actually starts, which lets a batch collect everything
   * queued behind the pnpm run in front of it.
   */
  private async pluginCommand(profile: string, title: string, build: string[][] | ((task: TaskHandle) => string[][])): Promise<void> {
    const { runtime, install } = await this.ready()
    const dshBin = await dshBinPath(install.dir)
    const dir = this.profileDir(profile)
    try {
      await this.tasks.run(title, async (task) => {
        const commands = typeof build === 'function' ? build(task) : build
        const env = await this.toolEnv(runtime)
        for (const args of commands) {
          task.log(`> dsh plugin --profile ${profile} ${args.join(' ')}\n`)
          task.progress(null, `pnpm ${args[0]} 进行中`)
          let timeouts = 0
          const result = await run(runtime.node, [dshBin, 'plugin', '--profile', profile, ...args], {
            cwd: this.paths.root,
            env,
            signal: task.signal,
            onOutput: (text) => {
              task.log(text)
              const detail = pnpmProgress(text)
              if (detail !== null) task.progress(null, detail)
              timeouts += text.match(/ETIMEDOUT/g)?.length ?? 0
            },
          })
          if (timeouts >= 3 && this.settings.mirror !== 'official') {
            this.notice('warning', `下载源超时 ${timeouts} 次，安装会变慢；可在设置里换个下载源`)
          }
          if (result.code === 0) continue
          // Only this run's output decides: pnpm-workspace.yaml keeps undecided names from earlier
          // attempts too, and attributing those to every later failure hides the real error.
          if (isBuildBlocked(result.output)) {
            if (args[0] === 'add') this.blockedInstalls.set(profile, { title, args })
            const pending = await readPendingBuilds(dir)
            const names = pending.length > 0 ? `（${pending.join('、')}）` : ''
            throw new Error(`pnpm 拒绝运行依赖的构建脚本${names}。确认来源可信后，可在插件页“允许构建”并自动重试`)
          }
          throw new Error(explainPnpmFailure(result.output) ?? `dsh plugin 失败（退出码 ${result.code}），详情见任务日志`)
        }
      })
    } finally {
      if (this.supervisor.running && this.supervisor.status.profile === profile) this.restartRequired = true
      this.send({ type: 'plugins-changed', profile })
      this.scheduleState()
    }
  }

  /**
   * Installs coalesce per profile: every pnpm run costs a full resolve plus pnpm's supply-chain
   * verification, so clicking three plugins in a row installs them in one run instead of three.
   */
  async installPlugin(profile: string, spec: string): Promise<void> {
    const { install } = await this.ready()
    const plan = await planInstall(this.hooks.fetch, this.endpoints.registry, spec, install.version, this.settings.channel)
    return this.installPlans(profile, [plan])
  }

  /** Queue plans for one profile. Handing them over together keeps them in the same pnpm run. */
  private installPlans(profile: string, plans: readonly InstallPlan[]): Promise<void> {
    const batch = this.installBatches.get(profile) ?? { plans: [], waiters: [], running: false }
    batch.plans.push(...plans)
    this.installBatches.set(profile, batch)
    const settled = new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }))
    if (!batch.running) {
      batch.running = true
      void this.flushInstalls(profile)
    }
    return settled
  }

  /** The plugin list of a profile, in the format "导入插件列表" reads back. */
  async pluginExport(profile: string): Promise<PluginExport> {
    const detail = await this.getProfile(profile)
    if (!detail.exists) throw new Error(`配置 “${profile}” 还没有创建，没有可导出的插件`)
    return buildPluginExport(detail, this.active?.version ?? null)
  }

  /**
   * Install what a plugin list names in one pnpm run, then restore which bundles were off.
   * Already-installed plugins and local paths from another machine are reported, not retried.
   */
  async importPluginList(profile: string, input: unknown): Promise<ImportResult> {
    const listed = parsePluginList(input)
    if (listed.length === 0) throw new Error('文件里没有可导入的插件')
    const { install } = await this.ready()
    const present = new Set((await this.getProfile(profile)).plugins.map(plugin => plugin.name))
    const skipped: ImportResult['skipped'] = []
    const wanted: string[] = []
    for (const plugin of listed) {
      if (present.has(plugin.name)) {
        skipped.push({ name: plugin.name, reason: '已安装' })
        continue
      }
      const restore = restoreSpec(plugin)
      if ('skip' in restore) skipped.push({ name: plugin.name, reason: restore.skip })
      else wanted.push(restore.spec)
    }
    const plans = await Promise.all(wanted.map(spec => planInstall(this.hooks.fetch, this.endpoints.registry, spec, install.version, this.settings.channel)))
    if (plans.length > 0) await this.installPlans(profile, plans)
    for (const plugin of listed.filter(item => !item.enabled && !present.has(item.name))) {
      await this.setBundleEnabled(profile, plugin.name, false).catch(() => undefined)
    }
    return { requested: listed.length, installed: plans.map(plan => plan.label), skipped }
  }

  private async flushInstalls(profile: string): Promise<void> {
    const batch = this.installBatches.get(profile)
    if (batch === undefined) return
    let waiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = []
    try {
      await this.pluginCommand(profile, '安装插件', (task) => {
        // Whatever queued up while the previous run held the lane rides along here.
        const plans = batch.plans.splice(0)
        waiters = batch.waiters.splice(0)
        this.installBatches.delete(profile)
        task.title(plans.length === 1 ? `安装插件 ${plans[0].label}` : `安装 ${plans.length} 个插件`)
        return addCommands(plans)
      })
      this.blockedInstalls.delete(profile)
      for (const waiter of waiters) waiter.resolve()
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error)
    } finally {
      this.installBatches.delete(profile)
    }
  }

  async removePlugin(profile: string, name: string): Promise<void> {
    await this.pluginCommand(profile, `卸载插件 ${name}`, [['remove', name]])
  }

  async checkPluginUpdates(profile: string): Promise<PluginUpdateCheck> {
    const detail = await this.getProfile(profile)
    return findPluginUpdates(this.hooks.fetch, this.endpoints.registry, detail.plugins, this.active?.version ?? null)
  }

  async updatePlugins(profile: string, updates: PluginUpdate[]): Promise<void> {
    if (updates.length === 0) return
    const title = updates.length === 1 ? `更新插件 ${updates[0].name} → ${updates[0].target}` : `更新 ${updates.length} 个插件`
    await this.pluginCommand(profile, title, planUpdates(updates))
  }

  async setBundleEnabled(profile: string, name: string, enabled: boolean): Promise<void> {
    let detail = await this.getProfile(profile)
    if (!detail.exists) {
      // `pnpm list` through dsh initializes the profile from its shipped template.
      await this.pluginCommand(profile, `初始化配置 ${profile}`, [['list']])
      detail = await this.getProfile(profile)
    }
    const plugin = detail.plugins.find(item => item.name === name)
    const builtin = detail.builtins.find(item => item.name === name)
    if (!(plugin?.bundle === true || builtin?.optional === true)) throw new Error(`${name} 不是可以切换的组合包`)
    const changed = await setBundleEnabled(detail.dir, name, enabled)
    if (changed && this.supervisor.running && this.supervisor.status.profile === profile) this.restartRequired = true
    this.send({ type: 'plugins-changed', profile })
    this.scheduleState()
  }

  async decideBuilds(profile: string, names: string[], allow: boolean): Promise<void> {
    await decideBuilds(this.profileDir(profile), names, allow)
    this.send({ type: 'plugins-changed', profile })
    const blocked = this.blockedInstalls.get(profile)
    if (blocked === undefined) return
    this.blockedInstalls.delete(profile)
    await this.pluginCommand(profile, `${blocked.title}（重试）`, [blocked.args])
  }

  // ---- diagnostics ----

  async testMirrors(): Promise<MirrorTiming[]> {
    return Promise.all(mirrorCandidates(this.settings).map(async (candidate) => {
      const { ms, error } = await measureRegistry(this.hooks.fetch, candidate.registry)
      return { ...candidate, ms, error }
    }))
  }

  /**
   * Every check the last few support threads needed, in one pass. pnpm is exercised with the
   * exact environment plugin installs get, so environment bugs surface here rather than there.
   */
  async runDoctor(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = []
    const add = (id: string, title: string, status: CheckStatus, detail: string, fix: CheckFix | null = null) => {
      checks.push({ id, title, status, detail, fix })
    }
    const probe = (command: string, args: string[], env?: NodeJS.ProcessEnv) =>
      run(command, args, { env, cwd: this.paths.root }).catch((error: unknown) => ({ code: -1, output: errorMessage(error) }))

    const runtime = this.node
    if (runtime === null) {
      add('node', 'Node.js 运行时', 'error', '尚未下载，在启动页点“一键安装”', 'setup')
    } else {
      const result = await probe(runtime.node, ['--version'])
      if (result.code === 0) add('node', 'Node.js 运行时', 'ok', `v${runtime.version}`)
      else add('node', 'Node.js 运行时', 'error', `无法运行：${lastLine(result.output)}`, 'setup')
    }

    const env = runtime === null ? null : await this.toolEnv(runtime)
    if (env !== null) {
      const empty = emptyProxyVariables(env)
      if (empty.length > 0) add('proxy-env', '子进程网络环境', 'error', `这些代理变量是空值，pnpm 会报 Invalid URL：${empty.join(', ')}`, 'settings')
      else add('proxy-env', '子进程网络环境', 'ok', '代理与下载源变量正常')
    }

    if (runtime === null || env === null || this.pnpmVersion === null) {
      add('pnpm', 'pnpm', 'error', '尚未安装', 'setup')
    } else {
      const result = await probe(runtime.node, [pnpmCliPath(this.paths), 'config', 'get', 'registry'], env)
      if (result.code === 0) add('pnpm', 'pnpm', 'ok', `${this.pnpmVersion}，使用下载源 ${lastLine(result.output)}`)
      else add('pnpm', 'pnpm', 'error', `读取配置失败：${explainPnpmFailure(result.output) ?? lastLine(result.output)}`, 'settings')
    }

    const install = this.active
    if (install === null || runtime === null) {
      add('dsh', 'dsh', 'error', '尚未安装', 'setup')
    } else {
      const result = await probe(runtime.node, [await dshBinPath(install.dir), '--version'], env ?? undefined)
      if (result.code === 0 && result.output.includes(install.version)) add('dsh', 'dsh', 'ok', `${install.version}（${this.settings.channel} 通道）`)
      else add('dsh', 'dsh', 'error', `无法运行：${lastLine(result.output)}`, 'versions')
    }

    const registry = this.endpoints.registry
    const timing = await measureRegistry(this.hooks.fetch, registry)
    if (timing.ms === null) add('registry', '下载源', 'error', `${registry} 无法访问：${timing.error}`, 'settings')
    else add('registry', '下载源', latencyStatus(timing.ms), `${registry} 响应 ${timing.ms} ms${timing.ms > 1500 ? '，偏慢，可在设置里测速换源' : ''}`, timing.ms > 1500 ? 'settings' : null)

    const home = await writableDir(this.dshHome)
    add('dsh-home', 'DSH_HOME', home.ok ? 'ok' : 'error', home.detail, home.ok ? null : 'settings')
    const launch = this.settings.launch
    const workspace = await writableDir(launch.workspace)
    add('workspace', '工作区', workspace.ok ? 'ok' : 'error', workspace.detail, workspace.ok ? null : 'home')

    const running = this.supervisor.running ? this.supervisor.status.port : null
    if (running === launch.port) add('port', '启动端口', 'ok', `${launch.port}（dsh 正在使用）`)
    else if (await isPortFree(launch.port)) add('port', '启动端口', 'ok', `${launch.port} 空闲`)
    else if (launch.autoPort) add('port', '启动端口', 'warn', `${launch.port} 被其他程序占用，启动时会自动换用下一个空闲端口`, 'home')
    else add('port', '启动端口', 'error', `${launch.port} 被其他程序占用，且没有开启自动换端口`, 'home')

    const profile = (await listProfiles(this.dshHome)).find(item => item.name === launch.profile)
    if (profile === undefined) {
      add('profile', '启动配置', 'error', `找不到配置 “${launch.profile}”`, 'home')
    } else if (!profile.web) {
      add('profile', '启动配置', 'error', `“${launch.profile}” 不含 Web 界面，启动器无法启动它`, 'home')
    } else {
      add('profile', '启动配置', 'ok', `${launch.profile}（${profile.plugins} 个插件）`)
      const detail = await this.getProfile(launch.profile)
      if (detail.pendingBuilds.length > 0) add('builds', '构建脚本', 'error', `待决定：${detail.pendingBuilds.join('、')}。决定之前这个配置下的所有安装都会失败`, 'plugins')
      else add('builds', '构建脚本', 'ok', '没有待决定的构建脚本')
      const missing = detail.plugins.filter(plugin => plugin.version === null)
      const suspect = detail.plugins.filter(plugin => plugin.compat === 'warn')
      if (missing.length > 0) add('plugins', '插件状态', 'error', `文件缺失：${missing.map(plugin => plugin.name).join('、')}`, 'plugins')
      else if (suspect.length > 0) add('plugins', '插件状态', 'warn', `声明的版本范围不含当前 dsh：${suspect.map(plugin => plugin.name).join('、')}`, 'plugins')
      else add('plugins', '插件状态', 'ok', detail.plugins.length > 0 ? `${detail.plugins.length} 个插件都正常` : '没有安装第三方插件')
    }

    return { checkedAt: new Date().toISOString(), launcherVersion: this.options.launcherVersion, platform: `${this.platform}-${this.arch}`, checks }
  }

  // ---- market ----

  async searchMarket(query: MarketQuery): Promise<MarketPage> {
    // The first search has to build the index; run it as a task so the progress is visible.
    if (!await this.market.hasIndex()) await this.refreshMarketIndex()
    return this.market.search(query)
  }

  /** Rebuild the local plugin index. Searches also refresh it in the background when it ages out. */
  async refreshMarketIndex(): Promise<void> {
    await this.tasks.run('更新插件索引', async (task) => {
      task.progress(null, '正在读取 npm 插件列表')
      const index = await this.market.refresh({
        signal: task.signal,
        onProgress: (fetched, total) => task.progress(total > 0 ? fetched / total : null, `已收录 ${fetched} / ${total} 个插件`),
      })
      this.notice('success', `插件索引已更新：共 ${index.entries.length} 个插件`)
    })
  }

  previewPackage(spec: string): Promise<PackagePreview> {
    return previewPackage(this.hooks.fetch, this.endpoints.registry, spec, this.active?.version ?? null)
  }

  // ---- settings ----

  async updateSettings(patch: SettingsPatch): Promise<void> {
    const before = this.settings
    const next = applySettingsPatch(before, patch, this.defaults)
    // Versions change only through their own actions.
    next.activeVersion = before.activeVersion
    next.pendingVersion = before.pendingVersion
    this.settings = next
    await saveSettings(this.paths.settings, next, this.hooks.codec)
    if (before.proxyMode !== next.proxyMode || before.proxyUrl !== next.proxyUrl) await this.hooks.applyProxy(next)
    if (before.autoCheck !== next.autoCheck) this.scheduleUpdateChecks()
    if (before.openAtLogin !== next.openAtLogin) this.hooks.applyLoginItem?.(next.openAtLogin)
    if (before.dshHome !== next.dshHome) this.send({ type: 'plugins-changed', profile: '*' })
    const launchInputs = (settings: Settings) => JSON.stringify([
      { ...settings.launch, openBrowser: null }, settings.dshHome, settings.mirror, settings.customRegistry,
      settings.proxyMode, settings.proxyUrl,
    ])
    if (this.supervisor.running && launchInputs(before) !== launchInputs(next)) this.restartRequired = true
    this.scheduleState()
  }
}
