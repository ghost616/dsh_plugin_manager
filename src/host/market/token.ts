/**
 * Credential-seam backed GitHub token source of the plugin market.
 *
 * The market never writes the token anywhere itself: the deployment's credential
 * provider (`ctx.credentials`, the `@deepseek-ai/dsh-credentials` seam) owns the
 * value and the market resolves *one reference per request* — never a stored
 * copy — so a token saved between two requests reaches the very next one.
 *
 * Reference order is the market's own rule: `DSH_GITHUB_TOKEN` first,
 * `GITHUB_TOKEN` second, so a deployment that sets both is unambiguous.
 *
 * Three facts this module pins:
 *
 * - **Missing seam means anonymous, not broken.** With no `ctx.credentials`
 *   mounted the provider returns no token and every read-only call goes out
 *   anonymously, keeping the launcher's historical behavior. The gate for
 *   surfaces that DO need the seam is {@link requireCredentials}, which fails
 *   loudly with `github/token-unavailable` instead of silently appearing to
 *   read or write a token that has no home.
 * - **A failing seam means anonymous too.** A resolve failure is reported and
 *   degraded, never propagated: `github/*` reads keep their own failure
 *   vocabulary and no read fails merely because credentials did.
 * - **No token is ever held.** The provider keeps no last value and exposes no
 *   way to read one; the GitHub client only turns it into a request header.
 *
 * The seam is read through `ctx.get('credentials')`, never through the
 * `ctx.credentials` property: cordis proxies every declared service accessor,
 * and a raw property read on a composition that never declared the credential
 * accessor THROWS ("cannot get property \"credentials\" without inject") — which
 * would fail every GitHub read of a deployment that simply has no credential
 * plugin. The inject-free lookup answers `undefined` there, which is the
 * "anonymous" fact this module is built around.
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { GitHubTokenSource } from '../../types.ts'
import { MarketError } from './errors.ts'
import type { TokenProvider } from './github.ts'

/** Preferred reference: the deployment's own `DSH_GITHUB_TOKEN`. */
export const GITHUB_TOKEN_REF = credentialRef('DSH_GITHUB_TOKEN')

/** Fallback reference, consulted only while the preferred one is absent. */
export const GITHUB_TOKEN_FALLBACK_REF = credentialRef('GITHUB_TOKEN')

/**
 * The two references the market resolves, in precedence order. The head is also
 * the reference an unconfigured deployment reports and a write targets.
 */
export const CREDENTIALS_GITHUB_TOKEN_REFS: readonly CredentialRef[] = [
  GITHUB_TOKEN_REF,
  GITHUB_TOKEN_FALLBACK_REF,
]

/** Optional diagnostic hook for a degraded token read (never a token value). */
export type TokenResolveWarn = (message: string) => void

/** Options of {@link credentialsTokenProvider}. */
export interface CredentialsTokenProviderOptions {
  /**
   * Called when the credential seam threw instead of answering; the read is
   * degraded to anonymous. Never receives the token value.
   */
  readonly onResolveError?: TokenResolveWarn
}

/**
 * The credential seam as this process sees it, or null when the deployment
 * mounted none. The check is structural (`resolve` is the one method the token
 * half needs) because `Context` declares `credentials` unconditionally: absence
 * is a runtime fact of this deployment, never a type-level one.
 */
export function credentialsServiceOf(ctx: Context): CredentialProvider | null {
  return credentialsOf(ctx)
}

/** Whether a credential seam is mounted, i.e. token reads/writes have a home. */
export function hasCredentialsSeam(ctx: Context): boolean {
  return credentialsOf(ctx) !== null
}

/**
 * The mounted credential seam, or a loud `github/token-unavailable` failure.
 * Token *surfaces* (status/update) go through this gate: with no seam mounted
 * there is nothing to read or write and no launch-environment fallback is
 * substituted, because a token "saved" there would look saved while the
 * environment kept shadowing it.
 */
export function requireCredentials(ctx: Context): CredentialProvider {
  const credentials = credentialsOf(ctx)
  if (credentials === null) {
    throw new MarketError(
      'github/token-unavailable',
      'This deployment has no credential seam, so the GitHub token cannot be read or written.',
    )
  }
  return credentials
}

/**
 * Resolve the effective GitHub token reference's current value through the
 * credential seam, or null when the deployment is anonymous (no seam mounted,
 * both references unconfigured, or the seam failed).
 *
 * Called per request — never memoized — which is what makes a saved token take
 * effect on the next GitHub call without a plugin restart.
 */
export async function resolveGitHubToken(
  ctx: Context,
  options: CredentialsTokenProviderOptions = {},
): Promise<string | null> {
  const credentials = credentialsOf(ctx)
  if (credentials === null) return null
  for (const ref of CREDENTIALS_GITHUB_TOKEN_REFS) {
    let value: string | undefined
    try {
      value = (await credentials.resolve(ref))?.value
    } catch (error) {
      // A failing seam must not fail GitHub reads: report and stay anonymous.
      warn(options, `The GitHub token reference could not be resolved (${describe(error)}); continuing anonymously.`)
      return null
    }
    // The seam guarantees a non-empty value; an empty one would still mean
    // "no bearer header" here, so it is treated as absent rather than sent.
    if (value !== undefined && value.length > 0) return value
  }
  return null
}

/**
 * The {@link TokenProvider} a host composition hands to `GitHubMarket`
 * (`new GitHubMarket({ tokenProvider: credentialsTokenProvider(ctx) })`): the
 * effective value is re-resolved per call through {@link resolveGitHubToken}.
 */
export function credentialsTokenProvider(
  ctx: Context,
  options: CredentialsTokenProviderOptions = {},
): TokenProvider {
  return () => resolveGitHubToken(ctx, options)
}

/**
 * The provenance layer behind one reference, straight off the seam (`'env'`,
 * `'file'`, `'project-env'`, `'user-env'`). Read-only and value-free, so a
 * token surface may render it. Undefined while unconfigured — a fact, not a
 * placeholder string.
 */
export async function gitHubTokenSourceOf(
  credentials: CredentialProvider,
  ref: CredentialRef,
): Promise<GitHubTokenSource | undefined> {
  const info = await credentials.describe(ref)
  if (!info.configured) return undefined
  // The seam's source vocabulary is provider-defined and open-ended, which is
  // exactly the shape of GitHubTokenSource (closed head + open tail).
  return info.source as GitHubTokenSource
}

function credentialsOf(ctx: Context): CredentialProvider | null {
  // `ctx.get` is the inject-free service lookup: reading `ctx.credentials`
  // directly THROWS on a context that never declared the credential accessor
  // ("cannot get property \"credentials\" without inject"), which would fail
  // every GitHub read of a deployment that simply has no credential plugin.
  // The structural check below is what tells a mounted provider from a missing
  // one, exactly as the surface-side half does.
  let candidate: unknown
  try {
    candidate = ctx.get('credentials')
  } catch {
    return null
  }
  if (typeof candidate !== 'object' || candidate === null) return null
  return typeof (candidate as { resolve?: unknown }).resolve === 'function'
    ? (candidate as CredentialProvider)
    : null
}

function warn(options: CredentialsTokenProviderOptions, message: string): void {
  options.onResolveError?.(message)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
