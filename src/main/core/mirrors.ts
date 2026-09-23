import type { MirrorId } from '../../shared/types'

export interface Endpoints {
  /** npm registry for packuments and installs, without a trailing slash. */
  registry: string
  /** Node.js distribution root holding index.json and v<version>/ folders. */
  nodeDist: string
}

export const MIRROR_PRESETS: Record<Exclude<MirrorId, 'custom'>, Endpoints & { label: string }> = {
  official: {
    label: '官方源（npmjs.org / nodejs.org）',
    registry: 'https://registry.npmjs.org',
    nodeDist: 'https://nodejs.org/dist',
  },
  npmmirror: {
    label: 'npmmirror 国内镜像',
    registry: 'https://registry.npmmirror.com',
    nodeDist: 'https://npmmirror.com/mirrors/node',
  },
}

/** Keyword search only works on the npmjs registry; mirrors return empty results. */
export const SEARCH_ENDPOINT = 'https://registry.npmjs.org/-/v1/search'

export const RELEASES_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases'

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function resolveEndpoints(settings: { mirror: MirrorId; customRegistry: string; customNodeMirror: string }): Endpoints {
  if (settings.mirror !== 'custom') {
    const { registry, nodeDist } = MIRROR_PRESETS[settings.mirror]
    return { registry, nodeDist }
  }
  return {
    registry: trimSlash(settings.customRegistry) || MIRROR_PRESETS.official.registry,
    nodeDist: trimSlash(settings.customNodeMirror) || MIRROR_PRESETS.official.nodeDist,
  }
}
