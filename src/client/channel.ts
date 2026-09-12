/**
 * Browser-half caller of the market control web channel (candidate B chosen by
 * the Host→Client channel spike): one same-origin `ctx.webServer` route
 * carrying a JSON envelope shaped like the native Remote result contract.
 *
 * Wire shape (see src/host/control/web-channel.ts):
 *   POST /api/plugins-market
 *   { "method": "status" | "listManaged" | "setEnabled" | "setClassification"
 *       | "requestRemove" | "confirmRemove" | "search" | "repositoryDetail"
 *       | "previewInstall" | "prepareDownload" | "classifyDownload"
 *       | "commitDownload" | "cancelDownload"
 *       | "tokenStatus" | "saveGitHubToken" | "clearGitHubToken",
 *     "args": { ... } }
 *   → { "ok": true, "value": ... }
 *   | { "ok": false, "error": { "code", "message", "details" } }
 *
 * The caller mirrors the Remote discipline: a call never rejects on a wire
 * failure — `ok: false` envelopes and transport failures both surface as an
 * `ok: false` result with a stable code, so consumers branch on
 * `result.ok`/`error.code` and never instanceof. Transport exceptions are
 * normalized at this single boundary, not defended against per call.
 */

import type {
  DownloadClassification,
  DownloadCommit,
  DownloadPreparation,
  GitHubSearchPage,
  GitHubTokenSource,
  GitHubTokenUpdateResult,
  GithubRefKind,
  ManagedPluginList,
  MarketStatus,
  MarketWireErrorCode,
  PluginInstallReview,
  PluginMarketClassification,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
  RepositoryDetail,
} from '../types.ts'

/** Exact route path registered by the Host control row. */
export const MARKET_CONTROL_WEB_PATH = '/api/plugins-market'

/** Stable client-side transport code (no Host equivalent exists). */
export type MarketUnreachableCode = 'market/unreachable'

/** Codes the web channel may carry: the wire vocabulary plus two locals. */
export type MarketClientWireCode =
  | MarketWireErrorCode
  | MarketUnreachableCode
  | 'gateway/internal'

/** Structured failure carried by every `ok: false` channel result. */
export interface MarketWireFailure {
  readonly code: MarketClientWireCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
}

/** Result contract mirroring the native Remote carrier (`ok` discriminant). */
export type MarketCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MarketWireFailure }

/** Typed failure thrown by {@link unwrap} at the consumer boundary. */
export class MarketCallFailure extends Error {
  readonly code: MarketClientWireCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(failure: MarketWireFailure) {
    super(failure.message)
    this.name = 'MarketCallFailure'
    this.code = failure.code
    this.details = failure.details
  }
}

/** Consumer-side branch: return the value or throw the typed failure. */
export function unwrap<T>(result: MarketCallResult<T>): T {
  if (result.ok) return result.value
  throw new MarketCallFailure(result.error)
}

/**
 * Read-only GitHub access-token status as the web channel transports it.
 *
 * The shared contract (`GitHubTokenStatus` in `src/types.ts`) types `ref` as the
 * credential seam's branded `CredentialRef`; the wire carries the plain string
 * the brand wraps (the seam's own wire rule), so this face pins the DECODED
 * shape the browser half actually receives. Rendering and comparing the
 * reference is therefore a plain string operation on this face, with no need to
 * cross-face cast or to reach for the brand's runtime helper.
 */
export interface MarketTokenStatus {
  /** Whether resolving the effective reference would currently return a value. */
  readonly configured: boolean
  /** Layer currently supplying the token; absent while unconfigured. */
  readonly source?: GitHubTokenSource
  /** Whether the active provider can write (and clear) the effective reference. */
  readonly writable: boolean
  /** Effective reference name (`DSH_GITHUB_TOKEN` preferred, then the raw one). */
  readonly ref: string
  /**
   * Redacted, display-only mask of the effective value as the HOST built it
   * (prefix + a fixed dot run + the last characters, or the dot run alone for a
   * value too short to keep any of it). Absent means "nothing to show" — the
   * host omits the field rather than sending an empty or placeholder string —
   * so a consumer renders it VERBATIM and never re-derives, re-masks or trims
   * it. It is the only value-derived string that ever crosses the wire.
   */
  readonly maskedHint?: string
}

/** Wire envelope as parsed from the HTTP body (typed locally, asserted below). */
type WireEnvelope =
  | { readonly ok: true; readonly value: unknown }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: unknown }
  }

/** Read the market activation facts (configured flag + repository root). */
export async function status(): Promise<MarketCallResult<MarketStatus>> {
  return post<MarketStatus>('status', {})
}

/** Read one managed-plugin list through the channel. */
export async function listManaged(): Promise<MarketCallResult<ManagedPluginList>> {
  return post<ManagedPluginList>('listManaged', {})
}

/**
 * Persist and apply one record's enablement through the channel.
 */
export async function setEnabled(
  key: PluginMarketKey,
  enabled: boolean,
): Promise<MarketCallResult<PluginMarketRecord>> {
  return post<PluginMarketRecord>('setEnabled', { key, enabled })
}

/**
 * Re-file one managed record under a different classification (the manual
 * correction path of the roster). An invalid label is refused by the host with
 * the stable `market/bad-request` code; the record itself is preserved.
 */
export async function setClassification(
  key: PluginMarketKey,
  classification: PluginMarketClassification,
): Promise<MarketCallResult<PluginMarketRecord>> {
  return post<PluginMarketRecord>('setClassification', { key, classification })
}

/** Step 1 of the double-confirmed removal protocol. */
export async function requestRemove(key: PluginMarketKey): Promise<MarketCallResult<RemoveRequest>> {
  return post<RemoveRequest>('requestRemove', { key })
}

/** Step 2 of the double-confirmed removal protocol. */
export async function confirmRemove(
  key: PluginMarketKey,
  token: string,
): Promise<MarketCallResult<RemoveOutcome>> {
  return post<RemoveOutcome>('confirmRemove', { key, token })
}

/**
 * GitHub topic search for dsh plugins.
 *
 * `refresh` is the page's EXPLICIT refresh: it is forwarded so the host engine
 * bypasses its read-only TTL cache for this one call. Omitting it (the default)
 * keeps the cached behavior exactly as before, page after page.
 */
export async function search(
  keywords: string | null,
  perPage?: number,
  page?: number,
  refresh?: boolean,
): Promise<MarketCallResult<GitHubSearchPage>> {
  const args: Record<string, unknown> = {}
  if (keywords !== null && keywords !== undefined) args.keywords = keywords
  if (perPage !== undefined) args.perPage = perPage
  if (page !== undefined) args.page = page
  // Only a real `true` travels: the legacy call serializes no `refresh` key at
  // all, so an older host sees precisely the request it always saw.
  if (refresh === true) args.refresh = true
  return post<GitHubSearchPage>('search', args)
}

/**
 * One aggregated repository detail read: repository metadata, branch/tag name
 * listings and the raw README, fetched by the Host in parallel (see
 * {@link RepositoryDetail}).
 *
 * `refresh` skips the host's read-only TTL cache for every query of the
 * aggregation (the detail view's explicit refresh).
 */
export async function repositoryDetail(
  repository: string,
  refresh?: boolean,
): Promise<MarketCallResult<RepositoryDetail>> {
  const args: { repository: string; refresh?: boolean } = { repository }
  if (refresh === true) args.refresh = true
  return post<RepositoryDetail>('repositoryDetail', args)
}

/**
 * Review one repository (or one of its refs) and mint its single-use download
 * confirmation. `refKind` selects the v2 per-ref review (`'branch'`/`'tag'`,
 * requires `version`); omitting it reviews the default branch the legacy way.
 *
 * Argument order follows the host surface (`repository, refKind, version`).
 */
export async function previewInstall(
  repository: string,
  refKind?: GithubRefKind,
  version?: string | null,
): Promise<MarketCallResult<PluginInstallReview>> {
  const args: { repository: string; version?: string; refKind?: GithubRefKind } = { repository }
  if (version !== undefined && version !== null) args.version = version
  if (refKind !== undefined) args.refKind = refKind
  return post<PluginInstallReview>('previewInstall', args)
}

/**
 * Download phase 1 — consume the single-use review confirmation and clone the
 * checkout into the host's private staging area. Nothing is filed, classified
 * or installed here; the answer carries the process-local download handle the
 * next two phases present (`token`), plus the facts of "sources cloned".
 */
export async function prepareDownload(
  repository: string,
  confirmToken: string,
  refKind?: GithubRefKind,
  version?: string | null,
): Promise<MarketCallResult<DownloadPreparation>> {
  const args: {
    repository: string
    confirmToken: string
    version?: string
    refKind?: GithubRefKind
  } = { repository, confirmToken }
  if (version !== undefined && version !== null) args.version = version
  if (refKind !== undefined) args.refKind = refKind
  return post<DownloadPreparation>('prepareDownload', args)
}

/**
 * Download phase 2 — classify the staged checkout. Model problems never
 * surface as a rejection: the host degrades them to
 * `outcome: 'unclassified' | 'failed'` with an `errorCode`, so the caller
 * renders the "not classified" state from the VALUE and only treats
 * `record/not-found` (unknown handle) as a genuine failure.
 */
export async function classifyDownload(
  token: string,
): Promise<MarketCallResult<DownloadClassification>> {
  return post<DownloadClassification>('classifyDownload', { token })
}

/**
 * Download phase 3 — swap the staged checkout in and file it under
 * `classification`. The label is the classification phase's verdict, or the one
 * the user corrected by hand.
 */
export async function commitDownload(
  token: string,
  classification: PluginMarketClassification,
): Promise<MarketCallResult<DownloadCommit>> {
  return post<DownloadCommit>('commitDownload', { token, classification })
}

/**
 * Cancel a staged download: the host deletes the staging directory (zero
 * residue) and forgets the handle. Idempotent — an already-committed or
 * already-cancelled handle answers `false` without touching the filesystem.
 */
export async function cancelDownload(token: string): Promise<MarketCallResult<boolean>> {
  return post<boolean>('cancelDownload', { token })
}

/**
 * Read the GitHub access-token status of this deployment (configured / source /
 * writable / effective reference). No secret is involved, so this is safe to
 * call before any repository exists; a deployment with no credential seam
 * mounted answers the stable `github/token-unavailable` code instead.
 */
export async function tokenStatus(): Promise<MarketCallResult<MarketTokenStatus>> {
  return post<MarketTokenStatus>('tokenStatus', {})
}

/**
 * Store one GitHub token in the credential seam's writable layer. The host
 * refuses an empty value with `github/bad-request` (never writing a blank) and
 * refuses a read-only launch environment with `github/token-unavailable`; the
 * answer is the status re-read after a committed write, plus the cache report.
 */
export async function saveGitHubToken(
  value: string | null,
): Promise<MarketCallResult<GitHubTokenUpdateResult>> {
  // The value is forwarded as-is: coercing it here would turn a missing value
  // into the literal string "null" and store a bogus bearer token. The host's
  // guard owns the refusal.
  return post<GitHubTokenUpdateResult>('saveGitHubToken', { value })
}

/**
 * Remove the effective GitHub token from the credential seam's writable layer
 * and answer the status re-read. A read-only launch environment is refused
 * exactly like a save (`github/token-unavailable`).
 */
export async function clearGitHubToken(): Promise<MarketCallResult<GitHubTokenUpdateResult>> {
  return post<GitHubTokenUpdateResult>('clearGitHubToken', {})
}

async function post<T>(method: string, args: object): Promise<MarketCallResult<T>> {
  let response: Response
  try {
    response = await fetch(MARKET_CONTROL_WEB_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args }),
    })
  } catch (error) {
    return unreachable(describeError(error))
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    // A non-JSON answer means the route (or its proxy) is not the channel.
    return unreachable(`the market control channel answered non-JSON (HTTP ${response.status}).`)
  }
  const envelope = parseEnvelope(payload)
  if (envelope === undefined) {
    return unreachable('the market control channel answered an unexpected envelope.')
  }
  // The value/error shape was already validated; only the generic T leaks out.
  return envelope as unknown as MarketCallResult<T>
}

function parseEnvelope(value: unknown): WireEnvelope | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.ok === true && 'value' in record) {
    return { ok: true, value: record.value }
  }
  if (record.ok === false) {
    const error = record.error
    if (typeof error !== 'object' || error === null) return undefined
    const fields = error as Record<string, unknown>
    if (typeof fields.code !== 'string' || typeof fields.message !== 'string') return undefined
    const details = typeof fields.details === 'object' && fields.details !== null
      ? fields.details
      : {}
    return { ok: false, error: { code: fields.code, message: fields.message, details } }
  }
  return undefined
}

function unreachable<T>(message: string): MarketCallResult<T> {
  return {
    ok: false,
    error: { code: 'market/unreachable', message, details: {} },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
