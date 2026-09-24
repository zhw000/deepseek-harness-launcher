import type { PluginExport, ProfileDetail } from '../../shared/types'
import { OFFICIAL_SCOPE } from './plugins'
import { classifySpec } from './profiles'
import { parsePackageSpec } from './registry'

export interface ListedPlugin {
  name: string
  spec: string
  enabled: boolean
}

export function buildPluginExport(detail: ProfileDetail, dshVersion: string | null, now = new Date()): PluginExport {
  return {
    format: 'dsh-launcher-plugins',
    version: 1,
    exportedAt: now.toISOString(),
    profile: detail.name,
    dshVersion,
    plugins: detail.plugins.map(plugin => ({ name: plugin.name, spec: plugin.spec, enabled: plugin.enabled })),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const validName = (name: unknown): name is string => typeof name === 'string' && parsePackageSpec(name)?.name === name

/**
 * Read a plugin list: the launcher's own export, or a dsh profile's package.json copied
 * from another machine (its dependencies, enabled when listed in dsh.profile.bundles).
 */
export function parsePluginList(input: unknown): ListedPlugin[] {
  if (!isRecord(input)) throw new Error('文件内容不是插件列表')
  if (input.format === 'dsh-launcher-plugins') {
    if (input.version !== 1) throw new Error(`不支持的插件列表版本：${String(input.version)}`)
    if (!Array.isArray(input.plugins)) throw new Error('插件列表缺少 plugins 字段')
    return input.plugins.flatMap((item) => {
      if (!isRecord(item) || !validName(item.name) || typeof item.spec !== 'string') return []
      return [{ name: item.name, spec: item.spec, enabled: item.enabled !== false }]
    })
  }
  const profile = isRecord(input.dsh) && isRecord(input.dsh.profile) ? input.dsh.profile : null
  if (isRecord(input.dependencies) && profile !== null && Array.isArray(profile.bundles)) {
    const bundles = profile.bundles
    return Object.entries(input.dependencies).flatMap(([name, spec]) => (
      validName(name) && typeof spec === 'string' ? [{ name, spec, enabled: bundles.includes(name) }] : []
    ))
  }
  throw new Error('无法识别的文件：需要启动器导出的插件列表，或 dsh 配置目录中的 package.json')
}

/** What to hand `pnpm add` for a listed plugin, or why it cannot be restored on this machine. */
export function restoreSpec(plugin: ListedPlugin): { spec: string } | { skip: string } {
  // Official packages follow whatever dsh runs here, so the recorded pin is dropped.
  if (plugin.name.startsWith(OFFICIAL_SCOPE)) return { spec: plugin.name }
  switch (classifySpec(plugin.spec)) {
    case 'registry':
      return { spec: `${plugin.name}@${plugin.spec}` }
    case 'git':
      return { spec: plugin.spec }
    case 'tarball':
      return /^https?:/i.test(plugin.spec) ? { spec: plugin.spec } : { skip: '本地压缩包在这台电脑上不存在' }
    case 'local':
      return { skip: '本地目录在这台电脑上不存在' }
    default:
      return { skip: `无法还原的依赖写法：${plugin.spec}` }
  }
}
