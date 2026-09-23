import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import type { Channel, RemoteInfo } from '../../shared/types'
import type { NodeRuntime } from './node-runtime'
import type { LauncherPaths } from './paths'
import { run } from './proc'
import type { Packument, VersionManifest } from './registry'
import { ensureDir, readJson, renameWithRetry, writeJsonAtomic } from './util'

export const DSH_PACKAGE = '@deepseek-ai/dsh'
const MARKER = '.launcher.json'

export function assertVersion(version: string): void {
  if (typeof version !== 'string' || semver.valid(version) !== version) throw new Error('无效的版本号')
}

export interface DshInstall {
  version: string
  dir: string
  installedAt: string | null
}

export function dshPackageDir(versionDir: string): string {
  return join(versionDir, 'node_modules', '@deepseek-ai', 'dsh')
}

export async function dshBinPath(versionDir: string): Promise<string> {
  const manifest = await readJson<VersionManifest>(join(dshPackageDir(versionDir), 'package.json'))
  const bin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.dsh
  if (!bin) throw new Error(`${versionDir} 中的 dsh 缺少 bin 入口`)
  return join(dshPackageDir(versionDir), bin)
}

async function readInstall(dir: string, version: string): Promise<DshInstall | null> {
  const manifest = await readJson<VersionManifest>(join(dshPackageDir(dir), 'package.json')).catch(() => null)
  if (manifest?.version !== version) return null
  const marker = await readJson<{ installedAt?: string }>(join(dir, MARKER)).catch(() => null)
  return { version, dir, installedAt: marker?.installedAt ?? null }
}

/** Installed versions, newest first. Staging and trash folders start with a dot and are skipped. */
export async function listInstalled(versionsRoot: string): Promise<DshInstall[]> {
  let names: string[]
  try {
    names = await readdir(versionsRoot)
  } catch {
    return []
  }
  const installs: DshInstall[] = []
  for (const name of names) {
    if (name.startsWith('.') || semver.valid(name) === null) continue
    const install = await readInstall(join(versionsRoot, name), name)
    if (install) installs.push(install)
  }
  return installs.sort((a, b) => semver.rcompare(a.version, b.version))
}

export interface InstallDshContext {
  runtime: NodeRuntime
  paths: LauncherPaths
  registry: string
  version: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  log: (text: string) => void
}

/**
 * Install one dsh version with npm into a staging folder, run its `--version`,
 * then rename it into place so a half-finished install never looks usable.
 */
export async function installDsh(ctx: InstallDshContext): Promise<DshInstall> {
  assertVersion(ctx.version)
  const target = join(ctx.paths.versions, ctx.version)
  const existing = await readInstall(target, ctx.version)
  if (existing) return existing
  await ensureDir(ctx.paths.versions)
  const staging = join(ctx.paths.versions, `.staging-${ctx.version}-${Date.now()}`)
  await ensureDir(staging)
  try {
    await writeJsonAtomic(join(staging, 'package.json'), { name: 'dsh-runtime', private: true })
    const result = await run(ctx.runtime.node, [
      ctx.runtime.npmCli, 'install', `${DSH_PACKAGE}@${ctx.version}`,
      '--save-exact', '--no-audit', '--no-fund', '--loglevel', 'http', '--registry', ctx.registry,
    ], { cwd: staging, env: ctx.env, signal: ctx.signal, onOutput: text => ctx.log(text) })
    if (result.code !== 0) throw new Error(`npm install 失败（退出码 ${result.code}），详情见任务日志`)
    const bin = await dshBinPath(staging)
    const check = await run(ctx.runtime.node, [bin, '--version'], { cwd: staging, env: ctx.env, signal: ctx.signal })
    if (check.code !== 0 || !check.output.includes(ctx.version)) {
      throw new Error(`dsh 自检失败：${check.output.trim() || `退出码 ${check.code}`}`)
    }
    const installedAt = new Date().toISOString()
    await writeJsonAtomic(join(staging, MARKER), { version: ctx.version, installedAt })
    await rm(target, { recursive: true, force: true })
    await renameWithRetry(staging, target)
    return { version: ctx.version, dir: target, installedAt }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/** Move the folder aside first so an interrupted delete never leaves a half-valid version. */
export async function removeDsh(paths: LauncherPaths, version: string): Promise<void> {
  assertVersion(version)
  const dir = join(paths.versions, version)
  const trash = join(paths.versions, `.trash-${version}-${Date.now()}`)
  await renameWithRetry(dir, trash)
  await rm(trash, { recursive: true, force: true, maxRetries: 3 })
}

/** Remove leftovers of interrupted installs and deletes. */
export async function cleanupVersionsRoot(versionsRoot: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(versionsRoot)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith('.staging-') || name.startsWith('.trash-')) {
      await rm(join(versionsRoot, name), { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export function toRemoteInfo(packument: Packument): RemoteInfo {
  const versions = semver.rsort(Object.keys(packument.versions).filter(version => semver.valid(version) !== null))
  return {
    distTags: packument['dist-tags'] ?? {},
    versions: versions.map(version => ({ version, time: packument.time?.[version] ?? null })),
    checkedAt: new Date().toISOString(),
  }
}

/** The channel's version when it is newer than `current` (or anything when nothing is installed). */
export function newerOnChannel(remote: RemoteInfo | null, channel: Channel, current: string | null): string | null {
  const target = remote?.distTags[channel]
  if (target === undefined || semver.valid(target) === null) return null
  if (current === null || semver.valid(current) === null) return target
  return semver.gt(target, current) ? target : null
}

/** Versions to delete: everything beyond the newest `keep`, never touching protected ones. */
export function pruneCandidates(installed: readonly string[], keep: number, protect: ReadonlyArray<string | null>): string[] {
  const candidates = installed.filter(version => !protect.includes(version) && semver.valid(version) !== null)
  return semver.rsort(candidates).slice(Math.max(0, keep))
}
