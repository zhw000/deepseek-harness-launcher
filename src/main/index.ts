import { existsSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, safeStorage, session, shell, Tray,
  type IpcMainInvokeEvent,
} from 'electron'
import iconPath from '../../resources/icon.png?asset'
import { API_METHODS, EVENT_CHANNEL, INVOKE_CHANNEL, type InvokeResult, type LauncherApi, type LauncherMethod, type OpenTarget } from '../shared/api'
import type { ImportResult, LauncherEvent, Phase, Settings } from '../shared/types'
import { LauncherService } from './core/launcher'
import { defaultDataRoot } from './core/paths'
import type { SecretCodec } from './core/settings'
import { ensureDir, errorMessage } from './core/util'

/** Methods answered here because they need Electron; the service answers the rest. */
const SHELL_METHODS = ['pickDirectory', 'pickFile', 'openPath', 'openExternal', 'exportPlugins', 'importPlugins'] as const
/** Passed by the login item: start in the tray without showing the window. */
const HIDDEN_FLAG = '--hidden'
type ServiceMethod = Exclude<LauncherMethod, (typeof SHELL_METHODS)[number]>
type Awaitable<F> = F extends (...args: infer A) => Promise<infer R> ? (...args: A) => R | Promise<R> : never
/** Compile-time proof that the service implements every forwarded API method. */
type ServiceContract = { [K in ServiceMethod]: Awaitable<LauncherApi[K]> }

const ALLOWED = new Set<string>(API_METHODS)
const PHASE_LABEL: Record<Phase, string> = { stopped: '未运行', starting: '启动中', running: '运行中', stopping: '停止中', crashed: '已崩溃' }

let service: LauncherService | null = null
let contract: ServiceContract | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let trayPhase: Phase | null = null
let trayHintShown = false
let quitting = false

/**
 * Where runtimes, dsh versions and settings live. In order: $DSH_LAUNCHER_DATA, the folder holding
 * the portable build (which runs from a temp copy, so only this variable knows the real location),
 * a `portable` marker file next to an unpacked build, then the per-user default.
 */
function dataRoot(): string {
  const override = process.env.DSH_LAUNCHER_DATA?.trim()
  if (override) return override
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR?.trim()
  if (portableDir) return join(portableDir, 'dsh-launcher-data')
  const exeDir = dirname(app.getPath('exe'))
  if (app.isPackaged && existsSync(join(exeDir, 'portable'))) return join(exeDir, 'data')
  return defaultDataRoot(process.platform, process.env)
}

async function applyProxy(settings: Settings): Promise<void> {
  const ses = session.defaultSession
  if (settings.proxyMode === 'none') await ses.setProxy({ mode: 'direct' })
  else if (settings.proxyMode === 'custom' && settings.proxyUrl !== '') {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: settings.proxyUrl, proxyBypassRules: '<local>' })
  } else await ses.setProxy({ mode: 'system' })
  await ses.forceReloadProxyConfig()
}

/** Hand an HTTP proxy to npm, pnpm and dsh. A system SOCKS proxy or DIRECT keeps the inherited environment. */
async function childProxy(settings: Settings): Promise<string | null | undefined> {
  if (settings.proxyMode === 'none') return null
  if (settings.proxyMode === 'custom') return settings.proxyUrl === '' ? null : settings.proxyUrl
  const rule = await session.defaultSession.resolveProxy('https://registry.npmjs.org/')
  const match = /^(PROXY|HTTPS)\s+([^;\s]+)/i.exec(rule.trim())
  if (match === null) return undefined
  return `${match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
}

function secretCodec(): SecretCodec | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  return {
    encrypt: plain => safeStorage.encryptString(plain).toString('base64'),
    decrypt: stored => safeStorage.decryptString(Buffer.from(stored, 'base64')),
  }
}

async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('只能打开 http(s) 链接')
  await shell.openExternal(url)
}

async function pickDirectory(initial?: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], defaultPath: initial }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

async function exportPlugins(profile: string): Promise<string | null> {
  const data = await service!.pluginExport(profile)
  const options: Electron.SaveDialogOptions = {
    title: '导出插件列表',
    defaultPath: `dsh-plugins-${profile}.json`,
    filters: [{ name: '插件列表', extensions: ['json'] }],
  }
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, JSON.stringify(data, undefined, 2) + '\n')
  return result.filePath
}

async function importPlugins(profile: string): Promise<ImportResult | null> {
  const options: Electron.OpenDialogOptions = {
    title: '导入插件列表',
    properties: ['openFile'],
    filters: [{ name: '插件列表或 package.json', extensions: ['json'] }],
  }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  const file = result.filePaths[0]
  if (result.canceled || file === undefined) return null
  let data: unknown
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new Error('无法读取这个文件：它不是有效的 JSON')
  }
  return service!.importPluginList(profile, data)
}

/**
 * A login start opens straight to the tray. The portable build runs from a temp copy, so
 * the login item must point at the real exe, or it breaks when that copy is cleaned up.
 */
function applyLoginItem(enabled: boolean): void {
  if (!app.isPackaged || process.platform === 'linux') return
  const path = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath
  app.setLoginItemSettings({ openAtLogin: enabled, path, args: [HIDDEN_FLAG] })
}

async function pickFile(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: '插件压缩包', extensions: ['tgz', 'gz'] }] }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

async function openPath(target: OpenTarget, profile?: string): Promise<void> {
  const svc = service!
  const state = svc.getState()
  let path: string
  if (target === 'profile') {
    if (!profile) throw new Error('缺少配置名称')
    path = svc.profileDir(profile)
    if (!await stat(path).then(() => true, () => false)) throw new Error('该配置尚未创建，首次启动或安装插件后才会生成目录')
  } else {
    path = {
      root: state.paths.root,
      dshHome: state.paths.dshHome,
      dshLogs: join(state.paths.dshHome, 'logs'),
      logs: state.paths.logs,
      workspace: state.settings.launch.workspace,
    }[target]
    await ensureDir(path)
  }
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return url.startsWith('file://') || (!app.isPackaged && devUrl !== undefined && url.startsWith(devUrl))
}

async function dispatch(method: LauncherMethod, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'pickDirectory': return pickDirectory(args[0] as string | undefined)
    case 'pickFile': return pickFile()
    case 'openPath': return openPath(args[0] as OpenTarget, args[1] as string | undefined)
    case 'openExternal': return openExternal(String(args[0]))
    case 'exportPlugins': return exportPlugins(String(args[0]))
    case 'importPlugins': return importPlugins(String(args[0]))
    default: {
      const handler = contract![method] as (...values: unknown[]) => unknown
      return await handler.apply(service, args)
    }
  }
}

function registerIpc(): void {
  ipcMain.handle(INVOKE_CHANNEL, async (event, method: unknown, args: unknown): Promise<InvokeResult> => {
    if (typeof method !== 'string' || !ALLOWED.has(method) || !Array.isArray(args)) return { ok: false, error: '无效的调用' }
    if (!isTrustedSender(event)) return { ok: false, error: '拒绝来自未知页面的调用' }
    try {
      return { ok: true, value: await dispatch(method as LauncherMethod, args) }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })
}

function forward(event: LauncherEvent): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENT_CHANNEL, event)
  if (event.type === 'state' && event.state.process.phase !== trayPhase) refreshTray()
}

function reportError(error: unknown): void {
  service?.notice('error', errorMessage(error))
}

function showWindow(): void {
  if (mainWindow === null) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'DSH Launcher',
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15161b' : '#f5f6fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => {
    if (!process.argv.includes(HIDDEN_FLAG)) window.show()
  })
  window.on('close', (event) => {
    if (quitting || !service?.isRunning || !service.currentSettings.closeToTray) return
    event.preventDefault()
    window.hide()
    if (!trayHintShown && process.platform === 'win32') {
      trayHintShown = true
      tray?.displayBalloon({ title: 'DSH Launcher', content: 'dsh 仍在后台运行，可从托盘图标打开或退出。' })
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  captureIfRequested(window)
}

function refreshTray(): void {
  if (tray === null || service === null) return
  const phase = service.getState().process.phase
  trayPhase = phase
  const running = phase === 'running'
  const idle = phase === 'stopped' || phase === 'crashed'
  tray.setToolTip(`DSH Launcher · dsh ${PHASE_LABEL[phase]}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开启动器', click: showWindow },
    { type: 'separator' },
    { label: '启动 dsh', enabled: idle, click: () => void service?.start().catch(reportError) },
    { label: '停止 dsh', enabled: running, click: () => void service?.stop().catch(reportError) },
    { label: '打开 Web 界面', enabled: running, click: () => void service?.openWebUI().catch(reportError) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
  tray.on('click', showWindow)
  refreshTray()
}

/**
 * Development aid for unpackaged runs: DSH_LAUNCHER_CAPTURE=<file.png> writes a screenshot once the
 * window has rendered, then quits. DSH_LAUNCHER_ROUTE=#/plugins picks the page first, and
 * DSH_LAUNCHER_SCRIPT=<file.js> runs a script in the page (it can drive window.launcher) and prints its result.
 */
function captureIfRequested(window: BrowserWindow): void {
  const target = process.env.DSH_LAUNCHER_CAPTURE
  if (app.isPackaged || !target) return
  window.webContents.once('did-finish-load', async () => {
    const route = process.env.DSH_LAUNCHER_ROUTE
    if (route) await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}`)
    const script = process.env.DSH_LAUNCHER_SCRIPT
    if (script) console.log('[script]', JSON.stringify(await window.webContents.executeJavaScript(await readFile(script, 'utf8'))))
    await new Promise(resolve => setTimeout(resolve, Number(process.env.DSH_LAUNCHER_CAPTURE_DELAY ?? 2500)))
    const image = await window.webContents.capturePage()
    await writeFile(target, image.toPNG())
    if (process.env.DSH_LAUNCHER_CAPTURE_EXIT !== '0') app.quit()
  })
}

async function boot(): Promise<void> {
  app.setAppUserModelId('com.dsh.launcher')
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  const launcher = new LauncherService({
    root: dataRoot(),
    launcherVersion: app.getVersion(),
    hooks: {
      fetch: (input, init) => net.fetch(input, init),
      applyProxy,
      childProxy,
      openExternal,
      applyLoginItem,
      codec: secretCodec(),
      locale: app.getLocale(),
    },
  })
  service = launcher
  contract = launcher
  launcher.on('event', forward)
  await launcher.init()
  registerIpc()
  createWindow()
  createTray()
  const { autoStartDsh, activeVersion } = launcher.currentSettings
  if (autoStartDsh && activeVersion !== null) void launcher.start().catch(reportError)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    if (service?.isRunning) {
      // Let dsh drain its sessions before the launcher goes away.
      event.preventDefault()
      void service.dispose().finally(() => app.quit())
    }
  })
  app.whenReady().then(boot).catch((error: unknown) => {
    dialog.showErrorBox('DSH Launcher 启动失败', errorMessage(error))
    app.exit(1)
  })
}
