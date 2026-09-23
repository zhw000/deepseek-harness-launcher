import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import extract from 'extract-zip'
import semver from 'semver'
import { downloadFile, getJson, getText, type FetchFn } from './http'
import type { LauncherPaths } from './paths'
import { run } from './proc'
import { ensureDir, formatBytes, pathExists, renameWithRetry } from './util'

/** `engines.node` of the deepseek-harness repository. */
export const DSH_NODE_RANGE = '^22.19.0 || >=24.0.0'

export interface NodeDistEntry {
  version: string
  lts: string | false
  files: string[]
}

export interface NodeArtifact {
  /** File id as listed in index.json `files`. */
  key: string
  file: string
  archive: 'zip' | 'tar.gz' | 'tar.xz'
  /** Top-level folder inside the archive. */
  folder: string
}

export function nodeArtifact(version: string, platform: NodeJS.Platform, arch: string): NodeArtifact {
  const v = version.startsWith('v') ? version : `v${version}`
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`不支持的 CPU 架构：${arch}`)
  switch (platform) {
    case 'win32':
      return { key: `win-${arch}-zip`, file: `node-${v}-win-${arch}.zip`, archive: 'zip', folder: `node-${v}-win-${arch}` }
    case 'darwin':
      return { key: `osx-${arch}-tar`, file: `node-${v}-darwin-${arch}.tar.gz`, archive: 'tar.gz', folder: `node-${v}-darwin-${arch}` }
    case 'linux':
      return { key: `linux-${arch}`, file: `node-${v}-linux-${arch}.tar.xz`, archive: 'tar.xz', folder: `node-${v}-linux-${arch}` }
    default:
      throw new Error(`不支持的平台：${platform}`)
  }
}

/** Newest LTS release that satisfies `range` and ships an archive for this platform. */
export function pickNodeVersion(index: readonly NodeDistEntry[], range: string, key: string): string | null {
  const candidates = index
    .filter(entry => entry.lts && entry.files.includes(key))
    .map(entry => entry.version.replace(/^v/, ''))
    .filter(version => semver.valid(version) && semver.satisfies(version, range))
  return semver.rsort(candidates)[0] ?? null
}

export function parseShasums(text: string, file: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim())
    if (match && match[2] === file) return match[1].toLowerCase()
  }
  return null
}

export interface NodeRuntime {
  version: string
  dir: string
  node: string
  npmCli: string
}

export function runtimeFromDir(dir: string, version: string, platform: NodeJS.Platform): NodeRuntime {
  return platform === 'win32'
    ? { version, dir, node: join(dir, 'node.exe'), npmCli: join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') }
    : { version, dir, node: join(dir, 'bin', 'node'), npmCli: join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') }
}

export function nodeBinDir(runtime: NodeRuntime): string {
  return dirname(runtime.node)
}

/** The newest managed runtime that satisfies `range` and is complete on disk. */
export async function findInstalledNode(nodeRoot: string, platform: NodeJS.Platform, range = DSH_NODE_RANGE): Promise<NodeRuntime | null> {
  let names: string[]
  try {
    names = await readdir(nodeRoot)
  } catch {
    return null
  }
  const versions = names
    .filter(name => /^v\d+\.\d+\.\d+$/.test(name))
    .map(name => name.slice(1))
    .filter(version => semver.satisfies(version, range))
  for (const version of semver.rsort(versions)) {
    const runtime = runtimeFromDir(join(nodeRoot, `v${version}`), version, platform)
    if (await pathExists(runtime.node) && await pathExists(runtime.npmCli)) return runtime
  }
  return null
}

export interface InstallNodeContext {
  fetch: FetchFn
  nodeDist: string
  paths: LauncherPaths
  platform: NodeJS.Platform
  arch: string
  signal?: AbortSignal
  progress: (fraction: number | null, detail: string) => void
  log: (text: string) => void
}

async function sha256Of(path: string): Promise<string | null> {
  if (!await pathExists(path)) return null
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function extractArchive(file: string, kind: NodeArtifact['archive'], dest: string): Promise<void> {
  if (kind === 'zip') {
    await extract(file, { dir: dest })
    return
  }
  const result = await run('tar', ['-xf', file, '-C', dest])
  if (result.code !== 0) throw new Error(`解压失败：${result.output.trim()}`)
}

/** Download, verify and unpack the newest suitable Node.js LTS into `<root>/node/v<version>`. */
export async function installNode(ctx: InstallNodeContext): Promise<NodeRuntime> {
  ctx.progress(null, '查询 Node.js 版本')
  const index = await getJson<NodeDistEntry[]>(ctx.fetch, `${ctx.nodeDist}/index.json`, { signal: ctx.signal })
  const key = nodeArtifact('0.0.0', ctx.platform, ctx.arch).key
  const version = pickNodeVersion(index, DSH_NODE_RANGE, key)
  if (version === null) throw new Error(`下载源中没有满足 dsh 要求（${DSH_NODE_RANGE}）的 Node.js LTS 版本`)
  const artifact = nodeArtifact(version, ctx.platform, ctx.arch)
  const base = `${ctx.nodeDist}/v${version}`
  ctx.log(`Node.js v${version}：${base}/${artifact.file}\n`)

  const sums = await getText(ctx.fetch, `${base}/SHASUMS256.txt`, { signal: ctx.signal })
  const sha256 = parseShasums(sums, artifact.file)
  if (sha256 === null) throw new Error(`SHASUMS256.txt 中没有 ${artifact.file}`)

  await ensureDir(ctx.paths.downloads)
  const archive = join(ctx.paths.downloads, artifact.file)
  if (await sha256Of(archive) === sha256) {
    ctx.log('复用已下载且校验通过的压缩包\n')
  } else {
    await downloadFile(ctx.fetch, `${base}/${artifact.file}`, archive, {
      signal: ctx.signal,
      sha256,
      onProgress: (received, total) => ctx.progress(
        total ? (received / total) * 0.85 : null,
        `下载 Node.js v${version}  ${formatBytes(received)}${total ? ` / ${formatBytes(total)}` : ''}`,
      ),
    })
    ctx.log(`SHA-256 校验通过：${sha256}\n`)
  }

  ctx.progress(0.88, '解压 Node.js')
  const staging = join(ctx.paths.node, `.staging-${version}-${Date.now()}`)
  await ensureDir(staging)
  try {
    await extractArchive(archive, artifact.archive, staging)
    const target = join(ctx.paths.node, `v${version}`)
    await rm(target, { recursive: true, force: true })
    await renameWithRetry(join(staging, artifact.folder), target)
    const runtime = runtimeFromDir(target, version, ctx.platform)
    const check = await run(runtime.node, ['--version'])
    if (check.code !== 0 || check.output.trim() !== `v${version}`) {
      throw new Error(`Node.js 自检失败：${check.output.trim() || `退出码 ${check.code}`}`)
    }
    await rm(archive, { force: true })
    ctx.progress(1, `Node.js v${version} 已就绪`)
    return runtime
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
