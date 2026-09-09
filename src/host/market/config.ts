import { isAbsolute, resolve, sep } from 'node:path'
import { MarketError } from './errors.ts'

/**
 * Optional LLM endpoint of the smart-install analyzer. Both fields are
 * optional at the config level (a provider may keep its own default model);
 * the analyzer only runs once {@link requireMarketLlm} resolves a complete
 * endpoint, otherwise the assembly reports `market/llm-unconfigured`.
 */
export interface MarketLlmConfig {
  /** Provider id of the completion backend (a dsh chat provider). */
  readonly provider?: string
  /** Model id used for the analysis call. */
  readonly model?: string
}

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
  /**
   * Validated LLM endpoint of the smart-install analyzer. Present only when
   * the raw config carried at least one non-blank `llm` field.
   */
  readonly llm?: MarketLlmConfig
}

/**
 * User-facing plugin Config of the plugin-market Host row (also the raw input
 * accepted by {@link normalizeMarketConfig}). Only `repositoryPath` is a user
 * setting; activation defaults (create-if-missing, harness linking) are
 * decided by the repository layer.
 */
export interface Config {
  /**
   * Directory of the local third-party plugin source repository (absolute, or
   * relative to the process cwd; a leading `~` expands to the home
   * directory). Omit it to keep the plugin market idle.
   */
  readonly repositoryPath?: string
  /**
   * Optional LLM endpoint of the smart-install analyzer. Omit it (or leave
   * provider/model blank) to run the market without install analysis.
   */
  readonly llm?: MarketLlmConfig
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
  const llm = normalizeLlmConfig(raw.llm)
  return {
    repositoryPath,
    createIfMissing: MARKET_CONFIG_DEFAULTS.createIfMissing,
    linkSharedHarness: MARKET_CONFIG_DEFAULTS.linkSharedHarness,
    ...(llm === undefined ? {} : { llm }),
  }
}

/** A complete, analyzer-usable LLM endpoint after {@link requireMarketLlm}. */
export interface MarketLlmEndpoint {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve a complete analyzer endpoint from the (possibly partial) llm
 * provider/model. A missing provider or model means the market is not
 * configured for smart install analysis; the assembly layer surfaces this
 * before calling any model.
 *
 * @throws {MarketError} `market/llm-unconfigured` when provider or model is
 * absent/blank.
 */
export function requireMarketLlm(
  provider: string | undefined,
  model: string | undefined,
): MarketLlmEndpoint {
  const providerId = provider?.trim()
  const modelId = model?.trim()
  if (!providerId || !modelId) {
    throw new MarketError(
      'market/llm-unconfigured',
      'The smart-install analyzer needs both Config.llm.provider and Config.llm.model; configure them (or leave Config.llm unset to disable install analysis).',
    )
  }
  return { provider: providerId, model: modelId }
}

/** Validate the raw `llm` section; null/absent yields undefined, blanks drop fields. */
function normalizeLlmConfig(value: unknown): MarketLlmConfig | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketError(
      'config/invalid',
      'Config "llm" must be an object with optional "provider"/"model" strings.',
    )
  }
  const raw = value as Record<string, unknown>
  const provider = normalizeLlmField(raw.provider, 'provider')
  const model = normalizeLlmField(raw.model, 'model')
  if (provider === undefined && model === undefined) return undefined
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

/** One `llm` field: non-empty trimmed string, otherwise undefined or config/invalid. */
function normalizeLlmField(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new MarketError(
      'config/invalid',
      `Config "llm.${name}" must be a string (or omitted).`,
    )
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
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
