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
 *       | "commitDownload" | "cancelDownload",
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

/** GitHub topic search for dsh plugins. */
export async function search(
  keywords: string | null,
  perPage?: number,
  page?: number,
): Promise<MarketCallResult<GitHubSearchPage>> {
  const args: Record<string, unknown> = {}
  if (keywords !== null && keywords !== undefined) args.keywords = keywords
  if (perPage !== undefined) args.perPage = perPage
  if (page !== undefined) args.page = page
  return post<GitHubSearchPage>('search', args)
}

/**
 * One aggregated repository detail read: repository metadata, branch/tag name
 * listings and the raw README, fetched by the Host in parallel (see
 * {@link RepositoryDetail}).
 */
export async function repositoryDetail(
  repository: string,
): Promise<MarketCallResult<RepositoryDetail>> {
  return post<RepositoryDetail>('repositoryDetail', { repository })
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
