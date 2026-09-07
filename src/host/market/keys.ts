import type { PluginMarketKey } from '../../types.ts'
import { MarketError } from './errors.ts'

/** Upper bound of a stable key (keeps derived directory/file names sane). */
export const PLUGIN_MARKET_KEY_MAX_LENGTH = 100

/** Characters never allowed: loader-forbidden colon plus path/record hazards. */
const FORBIDDEN_KEY_CHAR = /[\s:/\\\u0000]/

/**
 * True when `value` is a syntactically valid stable plugin-market key: 1..100
 * characters without whitespace, `:`, `/`, `\` or NUL, and not `.`/`..`.
 * GitHub-sourced keys conventionally look like `gh-owner-repo`.
 */
export function isValidPluginKey(value: string): value is PluginMarketKey {
  if (value.length === 0 || value.length > PLUGIN_MARKET_KEY_MAX_LENGTH) return false
  if (value === '.' || value === '..') return false
  return !FORBIDDEN_KEY_CHAR.test(value)
}

/**
 * Brand a validated raw key at the owning boundary. Throws
 * `record/key-invalid` (a {@link MarketError}) when the value is not a valid
 * stable key.
 */
export function parsePluginKey(value: string): PluginMarketKey {
  if (!isValidPluginKey(value)) {
    throw new MarketError(
      'record/key-invalid',
      `"${value}" is not a valid plugin-market key: 1..${PLUGIN_MARKET_KEY_MAX_LENGTH} characters without whitespace, ":", "/", "\\" or NUL, and not "." or "..".`,
    )
  }
  return value
}
