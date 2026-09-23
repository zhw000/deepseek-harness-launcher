import type { Channel, MirrorId, Phase, SpecSource } from '../../shared/types'

export const CHANNELS: Record<Channel, { label: string; hint: string }> = {
  latest: { label: '稳定', hint: 'latest 标签，推荐日常使用' },
  next: { label: '预发布', hint: 'next 标签，即将发布的版本' },
  alpha: { label: '尝鲜', hint: 'alpha 标签，最新功能，可能不稳定' },
}

export const PHASES: Record<Phase, string> = {
  stopped: '未运行',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  crashed: '启动失败',
}

export const SOURCES: Record<SpecSource, string> = {
  registry: 'npm',
  git: 'Git',
  local: '本地目录',
  tarball: '压缩包',
  other: '其他',
}

const pad = (value: number) => String(value).padStart(2, '0')

export function formatDate(iso: string | null, withTime = false): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000
  if (Number.isNaN(seconds)) return '—'
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`
  return formatDate(iso)
}

export function formatCount(value: number | null): string {
  if (value === null) return '—'
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)} 万`
  return value.toLocaleString('zh-CN')
}

/** Show a dsh URL without its sign-in token. */
export function displayUrl(url: string | null): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return url
  }
}

export function shortPath(path: string, max = 46): string {
  if (path.length <= max) return path
  return `${path.slice(0, 14)}…${path.slice(-(max - 15))}`
}

export const MIRROR_LABELS: Record<MirrorId, string> = {
  official: '官方源（npmjs.org / nodejs.org）',
  npmmirror: 'npmmirror 国内镜像',
  custom: '自定义源',
}
