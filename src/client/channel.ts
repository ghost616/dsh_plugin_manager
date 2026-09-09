/**
 * Browser-half caller of the market control web channel (candidate B chosen by
 * the Host→Client channel spike): one same-origin `ctx.webServer` route
 * carrying a JSON envelope shaped like the native Remote result contract.
 *
 * Wire shape (see src/host/control/web-channel.ts):
 *   POST /api/plugins-market
 *   { "method": "status" | "listManaged" | "setEnabled" | "requestRemove"
 *       | "confirmRemove" | "search" | "repositoryDetail" | "previewInstall"
 *       | "install",
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
  GitHubSearchPage,
  ManagedPluginList,
  MarketStatus,
  MarketWireErrorCode,
  PluginInstallOutcome,
  PluginInstallReview,
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

/** Persist and apply one record's enablement through the channel. */
export async function setEnabled(
  key: PluginMarketKey,
  enabled: boolean,
): Promise<MarketCallResult<PluginMarketRecord>> {
  return post<PluginMarketRecord>('setEnabled', { key, enabled })
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

/** Review one repository and mint its single-use install confirmation. */
export async function previewInstall(
  repository: string,
  version?: string | null,
): Promise<MarketCallResult<PluginInstallReview>> {
  const args: { repository: string; version?: string } = { repository }
  if (version !== undefined && version !== null) args.version = version
  return post<PluginInstallReview>('previewInstall', args)
}

/** Run the double-confirmed install for a reviewed repository. */
export async function install(
  repository: string,
  confirmToken: string,
  version?: string | null,
): Promise<MarketCallResult<PluginInstallOutcome>> {
  const args: { repository: string; confirmToken: string; version?: string } = { repository, confirmToken }
  if (version !== undefined && version !== null) args.version = version
  return post<PluginInstallOutcome>('install', args)
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
