import { isAbsolute, resolve, sep } from 'node:path'
import { MarketError } from './errors.ts'

/**
 * Normalized plugin-market Host configuration after validation/resolution.
 * The user-facing Config carries a single optional `repositoryPath`; the
 * remaining fields are activation defaults, not user settings.
 */
export interface MarketConfig {
  /**
   * Canonical absolute repository root when configured; null when the setting
   * is absent or blank (the market then stays idle until it is configured).
   */
  readonly repositoryPath: string | null
  /** Create a missing configured directory on activation (default false). */
  readonly createIfMissing: boolean
  /** Create/refresh the shared harness links on activation (default true). */
  readonly linkSharedHarness: boolean
}

/** Path-resolution environment supplied by the caller (injectable for tests). */
export interface ResolveEnvironment {
  /** Working directory used to absolutize relative paths. */
  readonly cwd: string
  /** Home directory used to expand a leading `~`. */
  readonly home: string
}

/** Activation defaults for the non-user-facing config fields. */
export const MARKET_CONFIG_DEFAULTS = {
  createIfMissing: false,
  linkSharedHarness: true,
} as const

/**
 * Validate and normalize the raw Host-plugin Config.
 *
 * @param input - raw loader config (may be `undefined`/`null`/partial).
 * @param env - path-resolution environment.
 * @throws {MarketError} `config/invalid` when a present `repositoryPath` is
 * not a string.
 */
export function normalizeMarketConfig(input: unknown, env: ResolveEnvironment): MarketConfig {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    throw new MarketError(
      'config/invalid',
      'Plugin-market Config must be an object with an optional "repositoryPath" string.',
    )
  }
  const raw = (input ?? {}) as Record<string, unknown>
  let repositoryPath: string | null = null
  if (raw.repositoryPath !== undefined && raw.repositoryPath !== null) {
    if (typeof raw.repositoryPath !== 'string') {
      throw new MarketError(
        'config/invalid',
        'Config "repositoryPath" must be a string path (or omitted to keep the plugin market idle).',
      )
    }
    const trimmed = raw.repositoryPath.trim()
    if (trimmed) repositoryPath = resolveConfiguredPath(trimmed, env)
  }
  return {
    repositoryPath,
    createIfMissing: MARKET_CONFIG_DEFAULTS.createIfMissing,
    linkSharedHarness: MARKET_CONFIG_DEFAULTS.linkSharedHarness,
  }
}

/** Absolutize a configured path: expand a leading `~`, resolve against cwd. */
function resolveConfiguredPath(value: string, env: ResolveEnvironment): string {
  const expanded = expandHome(value, env.home)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(env.cwd, expanded)
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home
  if (value.startsWith(`~${sep}`) || value.startsWith('~/')) {
    return joinHome(home, value.slice(2))
  }
  return value
}

function joinHome(home: string, rest: string): string {
  return rest.length === 0 ? home : `${home}${sep}${rest.replace(/^[/\\]+/, '')}`
}
