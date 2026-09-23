import type { Settings } from '../../shared/types'
import { resolveEndpoints } from './mirrors'
import { deleteEnv } from './proc'

const PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy',
  'pnpm_config_proxy', 'pnpm_config_http_proxy', 'pnpm_config_https_proxy', 'pnpm_config_no_proxy',
]

/** Build a fresh environment for every operation; never mutate the user's shell. */
export function childEnvironment(
  inherited: NodeJS.ProcessEnv, settings: Settings, dshHome: string,
  proxy: string | null | undefined, platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env = { ...inherited }
  deleteEnv(env, ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'DSH_HOME', 'npm_config_registry', 'pnpm_config_registry'])
  env.DSH_HOME = dshHome
  const registry = resolveEndpoints(settings).registry
  env.npm_config_registry = registry
  env.pnpm_config_registry = registry
  const existing = Object.entries(env).find(([key]) => key.toUpperCase() === 'NO_PROXY')?.[1] ?? ''
  const noProxy = proxy === null ? '*' : [...new Set([...existing.split(',').filter(Boolean), '127.0.0.1', 'localhost', '::1'])].join(',')
  const both = (key: string) => platform === 'win32' ? [key] : [key, key.toLowerCase()]
  if (proxy !== undefined) {
    deleteEnv(env, PROXY_KEYS)
    // An empty value is not "no proxy": pnpm parses it and dies with "Invalid URL",
    // which is why every plugin install failed. Direct means the variables are absent.
    if (proxy !== null) {
      for (const key of [...both('HTTP_PROXY'), ...both('HTTPS_PROXY'), 'npm_config_proxy', 'npm_config_https_proxy', 'pnpm_config_http_proxy', 'pnpm_config_https_proxy']) {
        env[key] = proxy
      }
    }
  }
  deleteEnv(env, ['NO_PROXY', 'npm_config_noproxy', 'pnpm_config_no_proxy'])
  for (const key of [...both('NO_PROXY'), 'npm_config_noproxy', 'pnpm_config_no_proxy']) env[key] = noProxy
  return env
}
