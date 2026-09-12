/**
 * Credential-seam bridge of the market CONTROL surface: the read/write half of
 * the GitHub access token.
 *
 * The market HOST half (`src/host/market/token.ts`) owns the request-side rule —
 * which reference is resolved for every GitHub call. This module owns the
 * settings-side rule: what a surface may show about the token, where a save is
 * allowed to land, and when a clear is allowed to run. Both halves share the
 * reference list, so precedence is stated once (see
 * `CREDENTIALS_GITHUB_TOKEN_REFS`).
 *
 * Three facts this module pins:
 *
 * - **The seam is optional, never a hard dependency.** `ctx.credentials` is
 *   read structurally on every call (`ctx.get('credentials')`, the reactive
 *   lookup the control assembly already uses for `ctx.llm`), so a deployment
 *   without the credential plugin keeps every other page working and only the
 *   token surface answers `github/token-unavailable`.
 * - **A save always targets the preferred head reference.** Writing the
 *   effective reference would be a trap: while the launch environment shadows
 *   `DSH_GITHUB_TOKEN`, a stored `GITHUB_TOKEN` would look saved and stay
 *   ineffective forever. Writing the head means the store can gain a value
 *   above the environment layer, and the next status re-read reports the new
 *   provenance. Clearing removes the EFFECTIVE reference (the one currently
 *   supplying the value) — unsetting a shadowed store entry would not change
 *   what the market sends.
 * - **Nothing is cached here.** Every operation re-reads the seam, so a change
 *   made between two calls is visible to the next one; the provider handed to
 *   `GitHubMarket` re-resolves per request too. The only memoized GitHub answer
 *   the market keeps is its read-only TTL cache, and the assembly drops that
 *   cache after every committed write.
 * - **The plaintext never leaves the host.** The status reports a redacted,
 *   display-only mask of the effective value (`GitHubTokenStatus.maskedHint`,
 *   built by {@link maskOf} from a read through the seam this call already
 *   resolved). The mask is the ONLY string derived from the value that may leave
 *   this module: the value lives in one local scope, is never logged, never
 *   attached to an error, never persisted, and never influences authorization,
 *   reference precedence or a write decision — it is presentation, nothing more.
 *   A value that cannot be read simply yields no mask (an absent field, never a
 *   placeholder), and that read failure never fails the status itself.
 *
 * Read-only rejections use one stable code (`github/token-unavailable`, the
 * same code the missing-seam case uses) so a client branches once: "this
 * deployment cannot change the token from here". The `message` carries the
 * specific reason (no seam / launch environment / failing seam) — details stay
 * empty, because the wire declaration for that code carries none.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { GitHubTokenStatus, GitHubTokenSource } from '../../types.ts'
import {
  CREDENTIALS_GITHUB_TOKEN_REFS,
  credentialsTokenProvider,
  gitHubTokenSourceOf,
  type CredentialsTokenProviderOptions,
} from '../market/token.ts'
import type { TokenProvider } from '../market/github.ts'
import type { ControlLogger } from './controller.ts'
import { MarketControlError } from './controller.ts'

/**
 * The credential seam surface this module consumes: describe one reference
 * (state + provenance + writability), store a non-empty value, remove one.
 *
 * Structural on purpose — the same shape `src/host/market/token.ts` consumes,
 * so a deployment's provider (the shipped `@deepseek-ai/dsh-credentials`
 * service, which is nominally unassignable across package copies, or a test
 * double) is accepted as long as it answers the members the seam promises.
 */
export interface CredentialSeam {
  describe(ref: CredentialRef): Promise<CredentialInfo>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

/**
 * Read-only status one token surface renders, carrying one extra host-side
 * fact that the shared `GitHubTokenStatus` deliberately has no slot for.
 *
 * `status.ref` (shared shape) is the reference the market RESOLVES — the
 * effective one, which is what "configured, from DSH_GITHUB_TOKEN" must name.
 * A save, however, must target the preferred head reference (see the module
 * docs), so the write target travels separately and stays off the wire.
 */
export interface TokenStatusReport {
  readonly status: GitHubTokenStatus
  /**
   * Reference a committed save writes to: always the preferred head
   * (`DSH_GITHUB_TOKEN`), so a stored value lands in a layer that can outrank
   * the launch environment instead of being shadowed by it.
   */
  readonly writeRefName: string
}

/**
 * The token half of the control surface, as `MarketSourceOperations` consumes
 * it. Every method rejects with a stable `MarketControlError`; the port owns no
 * cache and never holds a value (only the seam does).
 */
export interface GitHubTokenPort {
  /**
   * Read-only status (no secret slot, safe to cross the wire). A configured
   * deployment also carries the redacted `maskedHint` mask of the effective
   * value; an unconfigured one, or one whose value could not be read, omits the
   * field entirely.
   */
  status(): Promise<TokenStatusReport>
  /**
   * Store one non-empty token in the seam's writable layer. An empty value is
   * refused (the seam's own rule — a blank is absent everywhere, so writing one
   * could only erase); a read-only effective layer is refused as well.
   */
  save(value: string | null | undefined): Promise<TokenStatusReport>
  /** Remove the effective reference from the seam's writable layer. */
  clear(): Promise<TokenStatusReport>
}

/** Port used while the deployment mounted no credential seam at all. */
export function unavailableTokenPort(): GitHubTokenPort {
  const fail = (): never => {
    throw noSeam
  }
  return {
    status: async () => fail(),
    save: async () => fail(),
    clear: async () => fail(),
  }
}

/**
 * Build the token port of one activation context. The seam is looked up on
 * EVERY call (never captured at activation), so a credential provider mounted
 * after this row still serves the token surface.
 *
 * The options carry diagnostics only (a warning sink for a failing seam); no
 * token value ever reaches them.
 */
export function buildCredentialTokenPort(
  ctx: Context,
  options: { readonly logger?: ControlLogger } = {},
): GitHubTokenPort {
  return new CredentialTokenPort(ctx, options)
}

/** Wire name of one branded credential reference (it is a plain string). */
export function gitHubTokenRefName(ref: CredentialRef): string {
  return ref as unknown as string
}

/**
 * The seam as this deployment sees it right now, or null when none is mounted.
 *
 * `ctx.get` is the reactive, inject-free lookup: it answers the live
 * implementation without making `credentials` a hard dependency, which is
 * exactly the property the token surface needs (a headless deployment has no
 * credential plugin and must still boot).
 *
 * The structural `describe`/`set`/`unset` check is what keeps a malformed or
 * partially mounted service from being treated as a working seam (a value that
 * answers only `resolve`, say, cannot describe or write a reference). The
 * resolution then carries the same value as `CredentialProvider` for the
 * token-source helper (`gitHubTokenSourceOf` takes the credential package's own
 * type), which is a view of the SAME object — no second lookup, no copy.
 */
function seamOf(ctx: Context): SeamResolution | null {
  let candidate: unknown
  try {
    candidate = (ctx as { get?: (name: string) => unknown }).get?.('credentials')
  } catch {
    // A context whose reflection layer refuses the lookup has no seam either.
    return null
  }
  if (candidate === null || typeof candidate !== 'object') return null
  const seam = candidate as Partial<CredentialSeam>
  if (
    typeof seam.describe !== 'function'
    || typeof seam.set !== 'function'
    || typeof seam.unset !== 'function'
  ) {
    return null
  }
  return { seam: seam as CredentialSeam, info: candidate as CredentialProvider }
}

/** The stable "no token surface here" failure (empty details, see the header). */
function tokenUnavailable(message: string): MarketControlError {
  return new MarketControlError('github/token-unavailable', message)
}

const noSeam = tokenUnavailable(
  'This deployment has no credential seam, so the GitHub token cannot be read or written.',
)

/**
 * Turn any seam failure into the one stable token-unavailable failure. The
 * diagnostic is reported first and never carries a token value — the seam never
 * handed one out on this path.
 */
function unavailableDueTo(
  action: string,
  error: unknown,
  logger?: ControlLogger,
): MarketControlError {
  const message = `The GitHub token could not be ${action}: the credential seam failed (${describe(error)}).`
  logger?.warn(message)
  return tokenUnavailable(message)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class CredentialTokenPort implements GitHubTokenPort {
  constructor(
    private readonly ctx: Context,
    private readonly options: { readonly logger?: ControlLogger },
  ) {}

  async status(): Promise<TokenStatusReport> {
    return await this.read()
  }

  async save(value: string | null | undefined): Promise<TokenStatusReport> {
    if (!isProvided(value)) {
      // Never write a blank: the seam treats an empty stored value as absent,
      // so "save an empty token" could only erase what is there. Saying so is
      // the honest answer; the caller retries with a value or calls clear.
      throw new MarketControlError(
        'github/bad-request',
        'Refusing to store an empty GitHub token: pass a non-empty value, or clear the token instead.',
      )
    }
    const resolution = this.requireSeam()
    const current = await this.readWith(resolution)
    this.assertWritable(current, 'saved')
    try {
      // The HEAD reference, never the effective one: a stored value must be
      // able to outrank the launch environment instead of hiding under it.
      await resolution.seam.set(headRef(), value)
    } catch (error) {
      throw unavailableDueTo('saved', error, this.options.logger)
    }
    return await this.readWith(resolution)
  }

  async clear(): Promise<TokenStatusReport> {
    const resolution = this.requireSeam()
    const current = await this.readWith(resolution)
    this.assertWritable(current, 'cleared')
    try {
      // The EFFECTIVE reference: that is the value the market currently sends,
      // so that is the one a clear has to remove.
      await resolution.seam.unset(current.status.ref)
    } catch (error) {
      throw unavailableDueTo('cleared', error, this.options.logger)
    }
    return await this.readWith(resolution)
  }

  /** Read the status through a fresh seam lookup. */
  private async read(): Promise<TokenStatusReport> {
    return await this.readWith(this.requireSeam())
  }

  /** Read the status through an already resolved seam. */
  private async readWith(resolution: SeamResolution): Promise<TokenStatusReport> {
    const { seam } = resolution
    let effective: { readonly ref: CredentialRef; readonly info: CredentialInfo } | null = null
    for (const ref of CREDENTIALS_GITHUB_TOKEN_REFS) {
      let info: CredentialInfo
      try {
        info = await seam.describe(ref)
      } catch (error) {
        throw unavailableDueTo('read', error, this.options.logger)
      }
      if (!info.configured) continue
      effective = { ref, info }
      break
    }
    if (effective === null) {
      // Unconfigured: report the head as the ref so the surface can name the
      // reference a write would target, and let the seam say whether a write
      // there is possible at all (a deployment whose only layer is the
      // environment reports false, and the surface then offers no save action).
      let head: CredentialInfo
      try {
        head = await seam.describe(headRef())
      } catch (error) {
        throw unavailableDueTo('read', error, this.options.logger)
      }
      return {
        status: { configured: false, writable: head.writable, ref: headRef() },
        writeRefName: gitHubTokenRefName(headRef()),
      }
    }
    let source: GitHubTokenSource | undefined
    try {
      source = await gitHubTokenSourceOf(resolution.info, effective.ref)
    } catch (error) {
      throw unavailableDueTo('read', error, this.options.logger)
    }
    // Display-only mask of the value, built from a read through the seam this
    // call ALREADY resolved (no second service lookup, no caching of the service
    // or the value). SECURITY: the plaintext lives in this local scope only —
    // the status carries the derived mask, never the value, and no diagnostic on
    // any path of this function may include it.
    const maskedHint = await this.maskOf(resolution, effective.ref)
    return {
      status: {
        configured: true,
        ...(source === undefined ? {} : { source }),
        writable: effective.info.writable,
        ref: effective.ref,
        ...(maskedHint === undefined ? {} : { maskedHint }),
      },
      writeRefName: gitHubTokenRefName(headRef()),
    }
  }

  /**
   * The redacted display mask of one configured reference, or undefined when the
   * value cannot be read.
   *
   * A read failure here is DELIBERATELY silent and local: the status must keep
   * succeeding (a surface that cannot show a mask still shows the three state
   * facts), the failure introduces no new error code, and it never changes what
   * `status` reports about configured/source/writable — the mask is presentation
   * and has no say in any decision. The plaintext never leaves this method: only
   * {@link maskOf} derives a string from it, and no branch logs the value.
   */
  private async maskOf(resolution: SeamResolution, ref: CredentialRef): Promise<string | undefined> {
    let value: string | undefined
    try {
      value = (await resolution.info.resolve(ref))?.value
    } catch {
      // Diagnostic-free on purpose: the seam's own failure text is the provider's
      // business, and echoing it risks carrying provider-side detail this module
      // does not need. "No mask" is the whole answer.
      return undefined
    }
    if (value === undefined || value.length === 0) return undefined
    return maskOf(value)
  }

  /** Refuse a write the seam cannot make effective (read-only shadow). */
  private assertWritable(report: TokenStatusReport, verb: string): void {
    if (report.status.writable) return
    const ref = gitHubTokenRefName(report.status.ref)
    throw tokenUnavailable(
      report.status.source === 'env'
        ? `The GitHub token comes from the launch environment (${ref}), which is read-only: a token ${verb} here would be shadowed by it and never take effect. Set the token before starting dsh, or drop it from the environment first.`
        : `The GitHub token reference ${ref} cannot be ${verb}: the active credential provider reports it as read-only.`,
    )
  }

  private requireSeam(): SeamResolution {
    const resolution = seamOf(this.ctx)
    if (resolution === null) throw noSeam
    return resolution
  }
}

/**
 * One resolved seam: the three methods this module drives, plus the provider
 * itself for the source-provenance helper (`gitHubTokenSourceOf` takes the
 * seam's own type, so the resolution carries it instead of re-casting).
 */
interface SeamResolution {
  readonly seam: CredentialSeam
  readonly info: CredentialProvider
}

/** The preferred reference — the one a save always targets. */
function headRef(): CredentialRef {
  const head = CREDENTIALS_GITHUB_TOKEN_REFS[0]
  if (head === undefined) throw tokenUnavailable('The GitHub token reference list is empty.')
  return head
}

/** The fixed run of dots a mask always carries, independent of the value's length. */
const MASK_DOTS = '•'.repeat(8)

/** Longest prefix a mask may keep, in characters (underscore included). */
const MASK_PREFIX_MAX = 12

/** How many trailing characters a mask keeps of a long-enough value. */
const MASK_SUFFIX_LENGTH = 4

/**
 * Values this long or shorter carry no mask characters at all.
 *
 * The bound is what makes the mask non-invertible for the shortest values: at
 * exactly nine characters a "prefix + 8 dots + last 4" mask would cover the
 * whole value and simply re-print it, so anything at or below this length yields
 * the dots alone.
 */
const MASK_SHORT_VALUE_MAX = 8

/**
 * Redacted, display-only mask of one token value — the ONLY string ever derived
 * from the plaintext, and the only thing about it that may leave this module.
 *
 * The rule, applied in order:
 *
 * 1. a value of {@link MASK_SHORT_VALUE_MAX} characters or fewer yields the dots
 *    alone — no character of the value survives;
 * 2. the prefix is the value's opening up to and INCLUDING its first underscore,
 *    capped at {@link MASK_PREFIX_MAX} characters; a value without an underscore
 *    contributes no prefix at all;
 * 3. the kept characters must not cover the whole value: when they do, the mask
 *    degrades to the dots alone, exactly like a short value. This is a
 *    NECESSARY second guard, not a restatement of (1) — the first underscore
 *    may be the value's LAST character, which makes the prefix the entire value
 *    (`secretok_` → `secretok_••••••••tok_` would echo every character), and
 *    below roughly seventeen characters the prefix and suffix together can
 *    still spell the value out;
 * 4. always exactly {@link MASK_DOTS} dots, so the run never reveals the length;
 * 5. the value's last {@link MASK_SUFFIX_LENGTH} characters.
 *
 * `undefined` is never returned for a real value: the caller omits the field
 * instead, so "no mask" is an absent field rather than a placeholder string.
 */
export function maskOf(value: string): string {
  if (value.length <= MASK_SHORT_VALUE_MAX) return MASK_DOTS
  const underscore = value.indexOf('_')
  const prefix = underscore === -1 ? '' : value.slice(0, underscore + 1).slice(0, MASK_PREFIX_MAX)
  const suffix = value.slice(-MASK_SUFFIX_LENGTH)
  // Never let the kept characters cover the value: a fully reconstructible mask
  // is not a mask. Fall back to the dots alone (the same shape a short value
  // gets), so no shape of value can be read back out of its mask.
  if (prefix.length + suffix.length >= value.length) return MASK_DOTS
  return `${prefix}${MASK_DOTS}${suffix}`
}

/** Whether a caller actually supplied a token value (blank counts as absent). */
function isProvided(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The per-request token provider the assembly hands to `GitHubMarket`, so the
 * engine and the token surface resolve the same reference order through the
 * same seam (see `src/host/market/token.ts`).
 */
export function controlTokenProvider(
  ctx: Context,
  options: CredentialsTokenProviderOptions = {},
): TokenProvider {
  return credentialsTokenProvider(ctx, options)
}