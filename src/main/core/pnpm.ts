import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { NodeRuntime } from './node-runtime'
import type { LauncherPaths } from './paths'
import { run } from './proc'
import { ensureDir, readJson, writeJsonAtomic } from './util'

/**
 * dsh targets pnpm 11: its plugin manager relies on pnpm 11 recording blocked
 * dependency builds under `allowBuilds` in the profile's pnpm-workspace.yaml.
 */
export const PNPM_SPEC = 'pnpm@latest-11'

export function pnpmCliPath(paths: LauncherPaths): string {
  return join(paths.pnpm, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

export async function installedPnpmVersion(paths: LauncherPaths): Promise<string | null> {
  const manifest = await readJson<{ version?: string }>(join(paths.pnpm, 'node_modules', 'pnpm', 'package.json'))
  return manifest?.version ?? null
}

export interface InstallPnpmContext {
  runtime: NodeRuntime
  paths: LauncherPaths
  registry: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  log: (text: string) => void
}

export async function installPnpm(ctx: InstallPnpmContext): Promise<string> {
  await ensureDir(ctx.paths.pnpm)
  await writeJsonAtomic(join(ctx.paths.pnpm, 'package.json'), { name: 'dsh-launcher-pnpm', private: true })
  const result = await run(ctx.runtime.node, [
    ctx.runtime.npmCli, 'install', PNPM_SPEC,
    '--no-audit', '--no-fund', '--no-package-lock', '--registry', ctx.registry,
  ], { cwd: ctx.paths.pnpm, env: ctx.env, signal: ctx.signal, onOutput: text => ctx.log(text) })
  if (result.code !== 0) throw new Error(`pnpm 安装失败（npm 退出码 ${result.code}）`)
  const version = await installedPnpmVersion(ctx.paths)
  if (version === null) throw new Error('pnpm 安装后缺少 package.json')
  return version
}

async function writeIfChanged(path: string, content: string, mode?: number): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null)
  if (current !== content) await writeFile(path, content)
  if (mode !== undefined) await chmod(path, mode)
}

// Mirrors npm's cmd-shim: resolve the target relative to the shim itself.
const BACKSLASH = String.fromCharCode(92)
const SH_BASEDIR = `basedir=$(dirname "$(echo "$0" | sed -e 's,${BACKSLASH}${BACKSLASH},/,g')")`

/**
 * Write `pnpm` shims into bin/. Targets are addressed relative to the shim (`%~dp0`,
 * `$basedir`) so a data root under a non-ASCII user name survives cmd.exe code pages.
 */
export async function writeShims(paths: LauncherPaths, runtime: NodeRuntime, platform: NodeJS.Platform): Promise<void> {
  await ensureDir(paths.bin)
  const node = relative(paths.bin, runtime.node)
  const cli = relative(paths.bin, pnpmCliPath(paths))
  const posix = (path: string) => path.split(sep).join('/')
  const sh = ['#!/bin/sh', SH_BASEDIR, `exec "$basedir/${posix(node)}" "$basedir/${posix(cli)}" "$@"`, ''].join('\n')
  await writeIfChanged(join(paths.bin, 'pnpm'), sh, 0o755)
  if (platform === 'win32') {
    const cmd = ['@echo off', `"%~dp0${node}" "%~dp0${cli}" %*`, ''].join('\r\n')
    await writeIfChanged(join(paths.bin, 'pnpm.cmd'), cmd)
  }
}
