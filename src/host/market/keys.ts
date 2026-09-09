import { createHash } from 'node:crypto'
import type { PluginMarketKey } from '../../types.ts'
import { MarketError } from './errors.ts'
import { parseRepositorySlug } from './github.ts'
import { refSegOf } from './paths.ts'

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

/**
 * Derive the stable key unique to one `(owner, repo, ref-kind, ref)` install
 * tuple, e.g. `gh-owner~repo~branch~main`. The `~` separator can never appear
 * inside a GitHub slug half (`[A-Za-z0-9_.-]`) or inside a {@link refSegOf}
 * segment (only `[0-9a-z_%-]`), so the readable key is an unambiguous,
 * collision-free serialization of the tuple — and, containing `~`, it can
 * never equal a legacy `gh-${owner}-${repo}` key either.
 *
 * When the readable form would exceed the key length limit the whole tuple is
 * hashed (SHA-256 hex) so the key stays bounded and deterministic while the
 * risk of accidental collisions stays negligible. Throws `github/bad-request`
 * for a malformed slug and `record/key-invalid` for an unencodable ref.
 */
export function pluginKeyForGithubRef(
  repository: string,
  refKind: 'branch' | 'tag',
  ref: string,
): PluginMarketKey {
  const slug = parseRepositorySlug(repository)
  const slash = slug.indexOf('/')
  const owner = slug.slice(0, slash)
  const repo = slug.slice(slash + 1)
  const refSeg = refSegOf(ref)
  if (refSeg === null) {
    throw new MarketError(
      'record/key-invalid',
      `The ref "${ref}" cannot be encoded into a path-safe key segment.`,
    )
  }
  const readable = `gh-${owner}~${repo}~${refKind}~${refSeg}`
  if (isValidPluginKey(readable)) return readable
  // Bounded fallback: a full SHA-256 hex digest key (`gh` + 64 hex = 67 chars)
  // stays under PLUGIN_MARKET_KEY_MAX_LENGTH while remaining deterministic and
  // collision-safe regardless of owner/repo/ref length.
  const digest = createHash('sha256').update(`${slug}\u0000${refKind}\u0000${ref}`, 'utf8').digest('hex')
  return parsePluginKey(`gh${digest}`)
}
