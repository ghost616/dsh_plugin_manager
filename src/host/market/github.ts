/**
 * GitHub integration for the plugin market: repository search, detail queries
 * (default branch, branch/tag name listings, raw README) plus shared low-level
 * HTTP primitives used by the preview pipeline. Credentials are resolved per
 * request through an injectable {@link TokenProvider} (defaults to the
 * `DSH_GITHUB_TOKEN`/`GITHUB_TOKEN` environment variables; a credential-seam
 * backed provider lives in `./token.ts`) and only live in request headers at
 * runtime — they are never persisted, logged or cached on results.
 * Network/rate-limit/auth failures map to stable `github/*` codes.
 *
 * Three cross-cutting rules sit at the METHOD layer, so the primitives below
 * keep their exact semantics (error mapping included):
 *
 * 1. every read-only call (search, repository metadata, branches, tags,
 *    README) is served from a fixed {@link GITHUB_CACHE_TTL_MS} in-process TTL
 *    cache; nothing is persisted, so a process restart empties it naturally,
 *    and a caller opts out per call with the explicit `refresh` option;
 * 2. a throttled response (429, or 403 judged as a rate limit) is retried
 *    exactly once when GitHub reports a wait of at most
 *    {@link GITHUB_RATE_LIMIT_MAX_BACKOFF_MS}; the failure that finally
 *    surfaces always carries the reported wait in its `details`;
 * 3. nothing is cached on failure — a successful read is the only thing that
 *    fills the cache.
 */

import type { GitHubRepoSummary, GitHubSearchPage } from '../../types.ts'
import { MarketError } from './errors.ts'

/** Minimal fetch surface accepted by the GitHub client (injectable for tests). */
export interface FetchInit {
  readonly headers?: Record<string, string>
  // Not readonly: callers attach the signal conditionally after construction
  // (exactOptionalPropertyTypes forbids passing an explicit undefined).
  signal?: AbortSignal
}

/** Minimal response surface modeled on the Fetch Response object. */
export interface FetchResponse {
  readonly status: number
  /**
   * Transport-level success flag, present on real `Response` objects and used
   * by test doubles. Never read by this client: the GitHub mapping is driven by
   * `status` plus the rate-limit headers.
   */
  readonly ok?: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

/** Injectable fetch implementation (defaults to the global fetch). */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>

/** Runtime-only GitHub token source; returning null means anonymous calls. */
export type TokenProvider = () => string | null | Promise<string | null>

/** Default token source: environment variables, read per request, never stored. */
export function envTokenProvider(env: Record<string, string | undefined> = process.env): TokenProvider {
  return () => env.DSH_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? null
}

const API_BASE = 'https://api.github.com'

/**
 * Default fetch implementation (the platform fetch, looked up through the
 * global object so the host leaf needs no DOM ambient types).
 */
export const defaultFetchLike: FetchLike = (url, init) => {
  const platformFetch = (globalThis as unknown as {
    fetch(input: string, init?: FetchInit): Promise<FetchResponse>
  }).fetch
  return platformFetch(url, init)
}

/** Headers returned by one GitHub response (what error mapping may consult). */
export interface GitHubResponseHeaders {
  readonly rateLimitRemaining: string | null
  readonly rateLimitReset: string | null
  readonly retryAfter: string | null
}

/** Options of one {@link githubFetch} call. */
export interface GitHubRequestOptions {
  readonly token?: string | null
  // Not readonly: callers attach the signal conditionally after construction.
  signal?: AbortSignal
  /** Skip the Authorization header even when a token is present (raw reads). */
  readonly auth?: boolean
  /**
   * Accept media type override (default `application/vnd.github+json`); the
   * README endpoint switches to `application/vnd.github.raw` to receive the
   * Markdown text directly instead of the base64 JSON envelope.
   */
  readonly accept?: string
}

function collectHeaders(response: FetchResponse): GitHubResponseHeaders {
  return {
    rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
    rateLimitReset: response.headers.get('x-ratelimit-reset'),
    retryAfter: response.headers.get('retry-after'),
  }
}

/**
 * One low-level GitHub request: runs the fetch, maps transport/HTTP failures
 * onto stable {@link PluginMarketErrorCode github/*} codes and returns the
 * body text of any 2xx response. Never inspects or retains credentials.
 */
export async function githubFetch(
  fetchImpl: FetchLike,
  url: string,
  options: GitHubRequestOptions = {},
): Promise<{ readonly text: string; readonly headers: GitHubResponseHeaders }> {
  const headers: Record<string, string> = {
    accept: options.accept ?? 'application/vnd.github+json',
    'user-agent': 'dsh-plugin-market',
    'x-github-api-version': '2022-11-28',
  }
  const token = options.auth === false ? null : options.token ?? null
  if (token) headers.authorization = `Bearer ${token}`
  let response: FetchResponse
  try {
    // exactOptionalPropertyTypes: never pass an explicit `undefined` signal.
    const init: FetchInit = { headers }
    if (options.signal !== undefined) init.signal = options.signal
    response = await fetchImpl(url, init)
  } catch (error) {
    throw networkError(url, error)
  }
  const status = response.status
  if (status >= 200 && status < 300) {
    return { text: await readBody(response, url), headers: collectHeaders(response) }
  }
  const headersInfo = collectHeaders(response)
  throw errorFromStatus(status, headersInfo, url)
}

/** One throttled response, as `github/rate-limit` reports it to callers. */
interface RateLimitFacts {
  /**
   * Wait GitHub asked for, in milliseconds: the `retry-after` duration (delta
   * seconds or an HTTP date), else the gap to the `x-ratelimit-reset` instant.
   * Absent when the response reported neither, or reported a nonsensical one —
   * absence means "the wait is unknowable", never "retry immediately".
   */
  readonly retryAfterMs?: number
  /** `x-ratelimit-reset` as an ISO-8601 instant, when the header was usable. */
  readonly resetAt?: string
}

/**
 * Whether a non-2xx response is a rate limit rather than an auth failure.
 * Kept as the single predicate so the retry gate and the error mapping can
 * never disagree about which 403s are throttling.
 */
function isRateLimited(status: number, headers: GitHubResponseHeaders): boolean {
  if (status === 429) return true
  return status === 403 && (headers.rateLimitRemaining === '0' || headers.rateLimitReset !== null || headers.retryAfter !== null)
}

/** Read the two rate-limit facts off one throttled response. */
function rateLimitFacts(headers: GitHubResponseHeaders): RateLimitFacts {
  const resetAt = resetInstant(headers.rateLimitReset)
  // `retry-after` is the more direct answer (when GitHub sends it), so it wins
  // over a wait derived from the reset instant.
  const retryAfterMs = parseRetryAfterMs(headers.retryAfter) ?? (resetAt === undefined ? undefined : waitUntil(resetAt))
  const facts: { retryAfterMs?: number; resetAt?: string } = {}
  if (retryAfterMs !== undefined) facts.retryAfterMs = retryAfterMs
  if (resetAt !== undefined) facts.resetAt = resetAt
  return facts
}

/**
 * `x-ratelimit-reset` (epoch seconds) as an ISO-8601 instant; undefined when
 * the header is missing, non-numeric, or does not name a usable instant.
 */
function resetInstant(header: string | null): string | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  const instant = new Date(seconds * 1000)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

/** `retry-after` as a wait in milliseconds (delta seconds or an HTTP date). */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const text = header.trim()
  if (text.length === 0) return undefined
  const seconds = Number(text)
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.round(seconds * 1000) : undefined
  const date = Date.parse(text)
  if (Number.isNaN(date)) return undefined
  const wait = date - Date.now()
  return wait > 0 ? wait : undefined
}

/** Milliseconds from now until one ISO-8601 instant (0 when already past). */
function waitUntil(iso: string): number {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return 0
  return Math.max(0, at - Date.now())
}

/**
 * Map a non-2xx GitHub status onto the stable github/* failure vocabulary.
 * A throttled response always carries its reported wait in `details`, whether
 * or not the caller retried, so a consumer can render "wait N seconds".
 */
function errorFromStatus(status: number, headers: GitHubResponseHeaders, url: string): MarketError {
  const retryAfter = headers.retryAfter
  if (status === 401) {
    return new MarketError('github/auth', 'The GitHub request was rejected for invalid credentials.', { path: url })
  }
  if (isRateLimited(status, headers)) {
    const facts = rateLimitFacts(headers)
    const when = retryAfter
      ? `retry-after ${retryAfter}s`
      : facts.resetAt
        ? `rate limit resets at ${facts.resetAt}`
        : 'retry later'
    return new MarketError('github/rate-limit', `The GitHub API rate limit was exceeded (${when}). Configure a token or wait.`, {
      path: url,
      details: { ...facts },
    })
  }
  if (status === 403) {
    return new MarketError('github/auth', 'The GitHub request was denied (missing or invalid credentials).', { path: url })
  }
  if (status === 404) {
    return new MarketError('github/not-found', 'The GitHub resource was not found.', { path: url })
  }
  if (status >= 500 || status === 0) {
    return new MarketError('github/network', `The GitHub server failed (HTTP ${status}).`, { path: url })
  }
  return new MarketError('github/network', `The GitHub request failed (HTTP ${status}).`, { path: url })
}

/** Normalize one transport failure, keeping an abort reason intact. */
function networkError(url: string, error: unknown): MarketError {
  if (isAbortError(error)) {
    // A caller-cancelled request is not a GitHub outage: rethrow the caller's
    // own reason so its `AbortError`/custom value reaches the aborting caller.
    throw error
  }
  return new MarketError('github/network', `The GitHub request failed at the network level.`, { path: url, cause: error })
}

/** Whether one thrown value is the abort signal's own rejection. */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  const code = (error as { code?: unknown }).code
  return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR'
}

/**
 * Wall-clock wait for one backoff attempt, cancellable through the caller's
 * signal. Inlined (no timers import) so this module stays a dependency-free
 * leaf, and `unref`-ed so a stray wait can never hold the process open.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('The GitHub backoff wait was aborted.'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    if (signal === undefined) return
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One low-level GitHub request plus the plugin market's rate-limit backoff: a
 * throttled response is retried exactly once when GitHub reports a wait of at
 * most {@link GITHUB_RATE_LIMIT_MAX_BACKOFF_MS}. Anything else — no reported
 * wait, or a wait beyond the window — surfaces the {@link githubFetch} failure
 * unchanged (which still carries the reported wait in its `details`), so a
 * caller never has to know whether a backoff happened. Failures other than
 * rate limiting are never retried.
 */
export async function githubFetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  options: GitHubRequestOptions = {},
): Promise<{ readonly text: string; readonly headers: GitHubResponseHeaders }> {
  try {
    return await githubFetch(fetchImpl, url, options)
  } catch (error) {
    if (!(error instanceof MarketError) || error.code !== 'github/rate-limit') throw error
    const retryAfterMs = error.details.retryAfterMs
    if (typeof retryAfterMs !== 'number' || retryAfterMs > GITHUB_RATE_LIMIT_MAX_BACKOFF_MS) throw error
    await backoffSleep(retryAfterMs, options.signal)
    return await githubFetch(fetchImpl, url, options)
  }
}

/** Backoff wait with `github/network` mapping for an abnormal cancellation. */
async function backoffSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, signal)
  } catch (error) {
    throw networkError('github rate-limit backoff', error)
  }
}

async function readBody(response: FetchResponse, url: string): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    throw new MarketError('github/bad-response', 'The GitHub response body could not be read.', { path: url, cause: error })
  }
}

/** Parse one JSON GitHub body; shape failures surface as github/bad-response. */
export function parseGitHubJson(text: string, url: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new MarketError('github/bad-response', 'The GitHub response body is not valid JSON.', { path: url })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `owner/repo` slug syntax check. */
export function isValidRepositorySlug(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
}

/** Normalize and validate an `owner/repo` slug; throws github/bad-request. */
export function parseRepositorySlug(value: string): string {
  const trimmed = value.trim()
  if (!isValidRepositorySlug(trimmed)) {
    throw new MarketError('github/bad-request', `"${value}" is not an "owner/repo" GitHub slug.`, { path: value })
  }
  return trimmed
}

/** Search options for {@link GitHubMarket.search}. */
export interface GitHubSearchOptions {
  /** Free keyword appended to the `topic:dsh-plugin` query. */
  readonly keywords?: string
  /** Page size, clamped to 1..100 (default 20). */
  readonly perPage?: number
  /** 1-based page (default 1). */
  readonly page?: number
  /** Sort order (default by best match when omitted). */
  readonly sort?: 'stars' | 'updated'
  readonly order?: 'desc' | 'asc'
  readonly signal?: AbortSignal
  /**
   * Repositories excluded from the results (always applied, whether or not a
   * keyword is given). GitHub's repository search honors the negated
   * `-repo:owner/name` qualifier, so the exclusion rides in the query string;
   * a defensive item-level filter below keeps the guarantee even when a
   * server variant ignores the qualifier.
   */
  readonly exclude?: readonly string[]
  /**
   * Skip the TTL cache for this call: go to GitHub and refill the cache with
   * the fresh answer. This is the explicit refresh of the browse/search page —
   * ordinary calls reuse a cached page within {@link GITHUB_CACHE_TTL_MS}.
   */
  readonly refresh?: boolean
}

/** Repository never offered as an install source: the harness's own checkout. */
export const SEARCH_EXCLUDED_REPOS: readonly string[] = ['deepseek-ai/deepseek-harness']

/**
 * How long one successful read-only GitHub answer is reused, in milliseconds
 * (10 minutes). The cache lives in process memory only — nothing is persisted,
 * so a restart empties it — and every read method accepts the explicit
 * `refresh` option to bypass it.
 */
export const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Longest rate-limit wait this client is willing to absorb before retrying
 * once, in milliseconds. A throttled response reporting a longer wait (or no
 * usable wait at all) is surfaced to the caller instead of slept on.
 */
export const GITHUB_RATE_LIMIT_MAX_BACKOFF_MS = 5_000

/**
 * Explicit options of the read-only repository calls (`repositoryMeta`,
 * `branches`, `tags`, `readme`). An absent option object means "cache may
 * serve this, no cancellation token".
 */
export interface GitHubReadOptions {
  /** Skip the TTL cache for this call and refill it with the fresh answer. */
  readonly refresh?: boolean
  /** Caller cancellation, attached to every network hop of the call. */
  readonly signal?: AbortSignal
}

/** Page size for the branches/tags listing endpoints (GitHub's maximum). */
export const GITHUB_LIST_PAGE_SIZE = 100

/** Hard cap on listing pages fetched in one branches/tags call. */
export const GITHUB_LIST_MAX_PAGES = 5

/** Accept media type that returns the README file content (Markdown) directly. */
const README_RAW_MEDIA_TYPE = 'application/vnd.github.raw'

/** Options for {@link GitHubMarket}. */
export interface GitHubMarketOptions {
  readonly fetchImpl?: FetchLike
  readonly tokenProvider?: TokenProvider
  /** API base override for tests (defaults to api.github.com). */
  readonly baseUrl?: string
}

/** GitHub repository metadata used by search results and previews. */
export interface GitHubRepoMeta {
  readonly slug: string
  readonly name: string
  readonly description: string | null
  readonly stars: number
  readonly updatedAt: string | null
  readonly url: string
  readonly cloneUrl: string
  /** Default branch reported by the API (fallback 'main'). */
  readonly defaultBranch: string
}

/**
 * GitHub repository search/preview backend of the plugin market. Injectable
 * fetch + token source keep every unit test off the network.
 *
 * The class also owns the process-local TTL cache of read-only answers ({@link
 * GITHUB_CACHE_TTL_MS}) and the rate-limit backoff policy ({@link
 * GITHUB_RATE_LIMIT_MAX_BACKOFF_MS}); both sit here, at the method layer, so
 * the {@link githubFetch} primitives keep their exact semantics.
 */
export class GitHubMarket {
  private readonly fetchImpl: FetchLike
  private readonly tokenProvider?: TokenProvider
  private readonly baseUrl: string
  /**
   * One process-local map of read-only answers. Deliberately not persisted:
   * a restart empties it, and {@link clearCache} empties it on demand.
   */
  private readonly cache = new Map<string, { readonly expiresAt: number; readonly value: unknown }>()

  constructor(options: GitHubMarketOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? defaultFetchLike
    this.tokenProvider = options.tokenProvider ?? envTokenProvider()
    this.baseUrl = options.baseUrl ?? API_BASE
  }

  /**
   * Search repositories under `topic:dsh-plugin` (optionally narrowed by
   * keywords), always excluding {@link SEARCH_EXCLUDED_REPOS} (and any
   * caller-provided exclusions). Result items carry repository metadata only.
   */
  async search(options: GitHubSearchOptions = {}): Promise<GitHubSearchPage> {
    const perPage = clampInt(options.perPage, 1, 100, 20)
    const page = clampInt(options.page, 1, 1_000_000, 1)
    const keywords = options.keywords?.trim()
    const excludes = options.exclude ?? SEARCH_EXCLUDED_REPOS
    // Query-level exclusion: GitHub repository search supports negated
    // qualifiers (`-QUALIFIER`); this keeps counts and paging server-side.
    const parts = ['topic:dsh-plugin']
    if (keywords) parts.push(keywords)
    for (const repo of excludes) parts.push(`-repo:${repo}`)
    const q = parts.join(' ')
    const params = new URLSearchParams({
      q,
      per_page: String(perPage),
      page: String(page),
    })
    if (options.sort) {
      params.set('sort', options.sort)
      params.set('order', options.order ?? 'desc')
    }
    const url = `${this.baseUrl}/search/repositories?${params.toString()}`
    // The identifier IS the query: keywords, page, per_page, sort and order
    // and the exclusion set all reach it, so two different searches can never
    // share one cache entry.
    const cacheKey = `search:${params.toString()}`
    return this.loadCached<GitHubSearchPage>(cacheKey, options.refresh === true, async () => {
      const request: GitHubRequestOptions = { token: await this.resolveToken() }
      if (options.signal !== undefined) request.signal = options.signal
      const body = await githubFetchWithRetry(this.fetchImpl, url, request)
      return this.parseSearchPage(body.text, url, excludes)
    })
  }

  /**
   * Repository metadata (also resolves the default branch) for one slug. Cached
   * under the slug's metadata entry; `refresh` bypasses the cache.
   */
  async repositoryMeta(slug: string, options: GitHubReadOptions = {}): Promise<GitHubRepoMeta> {
    const ownerRepo = parseRepositorySlug(slug)
    const url = `${this.baseUrl}/repos/${ownerRepo}`
    return this.loadCached<GitHubRepoMeta>(`meta:${ownerRepo}`, options.refresh === true, async () => {
      const request: GitHubRequestOptions = { token: await this.resolveToken() }
      if (options.signal !== undefined) request.signal = options.signal
      const body = await githubFetchWithRetry(this.fetchImpl, url, request)
      const data = parseGitHubJson(body.text, url)
      if (!isObject(data)) {
        throw new MarketError('github/bad-response', 'The GitHub repository response is not an object.', { path: url })
      }
      const defaultBranch = typeof data.default_branch === 'string' && data.default_branch.length > 0
        ? data.default_branch
        : 'main'
      const summary = toRepoSummary(data)
      return {
        slug: ownerRepo,
        name: summary?.name ?? ownerRepo,
        description: summary?.description ?? null,
        stars: summary?.stars ?? 0,
        updatedAt: summary?.updatedAt ?? null,
        url: summary?.url ?? `https://github.com/${ownerRepo}`,
        cloneUrl: summary?.cloneUrl ?? `https://github.com/${ownerRepo}.git`,
        defaultBranch,
      }
    })
  }

  /**
   * Branch names of one repository. Fetched in pages of
   * {@link GITHUB_LIST_PAGE_SIZE} up to a cap of
   * {@link GITHUB_LIST_MAX_PAGES} pages; a short page stops the paging early.
   * Result carries the names only (no commit/credential data). Cached per
   * `(slug, resource)`; `refresh` bypasses the cache.
   */
  async branches(slug: string, options: GitHubReadOptions = {}): Promise<readonly string[]> {
    return this.listRefNames('branches', slug, options)
  }

  /** Tag names of one repository, paginated and cached exactly like {@link branches}. */
  async tags(slug: string, options: GitHubReadOptions = {}): Promise<readonly string[]> {
    return this.listRefNames('tags', slug, options)
  }

  /**
   * Raw Markdown of the repository README, or null when the repository has no
   * README (GitHub answers 404 for the endpoint). Other failures keep their
   * mapped `github/*` codes. Both answers are cacheable — the null is a real
   * answer, not an error — and `refresh` bypasses the cache.
   */
  async readme(slug: string, options: GitHubReadOptions = {}): Promise<string | null> {
    const ownerRepo = parseRepositorySlug(slug)
    const url = `${this.baseUrl}/repos/${ownerRepo}/readme`
    return this.loadCached<string | null>(`readme:${ownerRepo}`, options.refresh === true, async () => {
      const request: GitHubRequestOptions = { token: await this.resolveToken(), accept: README_RAW_MEDIA_TYPE }
      if (options.signal !== undefined) request.signal = options.signal
      try {
        const body = await githubFetchWithRetry(this.fetchImpl, url, request)
        return body.text
      } catch (error) {
        // A missing README is an ordinary "no such file" signal on this endpoint.
        if (error instanceof MarketError && error.code === 'github/not-found') return null
        throw error
      }
    })
  }

  /**
   * Drop every cached read-only answer, so the next call of each request goes
   * to GitHub again. Called after a token save/clear (a different credential
   * means different authorization, and rate-limit state changes with it) and
   * available to a caller that wants a hard refresh of everything.
   * @returns how many entries were dropped.
   */
  clearCache(): number {
    const dropped = this.cache.size
    this.cache.clear()
    return dropped
  }

  /** Resolve the runtime token (anonymous when none is configured). */
  async resolveToken(): Promise<string | null> {
    if (!this.tokenProvider) return null
    const token = await this.tokenProvider()
    return token && token.length > 0 ? token : null
  }

  /**
   * Serve one read-only call from the TTL cache, else run `fetchValue` and fill
   * the cache with its result. `signal` rides on the fetch itself, so a cache
   * hit never touches it.
   */
  private async loadCached<T>(
    key: string,
    refresh: boolean,
    fetchValue: () => Promise<T>,
  ): Promise<T> {
    if (!refresh) {
      const cached = this.cache.get(key)
      if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value as T
      // An expired entry is dropped eagerly; a wake-up after the TTL must never
      // resurrect a stale answer.
      if (cached !== undefined) this.cache.delete(key)
    }
    const value = await fetchValue()
    // Only a successful read fills the cache: a failure stays a failure, and a
    // concurrent reader that lost the race simply overwrote with fresh data.
    this.cache.set(key, { expiresAt: Date.now() + GITHUB_CACHE_TTL_MS, value })
    return value
  }

  /** Map one search response body onto the client-safe page (exclusions applied). */
  private parseSearchPage(text: string, url: string, excludes: readonly string[]): GitHubSearchPage {
    const data = parseGitHubJson(text, url)
    if (!isObject(data)) {
      throw new MarketError('github/bad-response', 'The GitHub search response is not an object.', { path: url })
    }
    const rawItems = data.items
    if (!Array.isArray(rawItems)) {
      throw new MarketError('github/bad-response', 'The GitHub search response carries no items array.', { path: url })
    }
    const excluded = new Set<string>(excludes)
    const items: GitHubRepoSummary[] = []
    let filteredOut = 0
    for (const raw of rawItems) {
      const item = toRepoSummary(raw)
      if (item && excluded.has(item.repository)) {
        filteredOut += 1
        continue
      }
      if (item) items.push(item)
    }
    const serverTotal = typeof data.total_count === 'number' ? data.total_count : items.length
    return {
      // If a server variant ignored the exclusion qualifier, the single
      // excluded repo may have been counted server-side; subtract what this
      // page actually dropped so counts stay consistent.
      totalCount: Math.max(0, serverTotal - filteredOut),
      items,
    }
  }

  /**
   * Fetch the `name` entries of a paginated branch/tag listing endpoint, or
   * serve them from the per-`(slug, resource)` cache entry.
   * The runtime token is resolved once per fetch (not per page), so the token
   * source — e.g. the environment reader — is never consulted in a loop.
   * @param kind endpoint suffix: `branches` or `tags`
   */
  private async listRefNames(
    kind: 'branches' | 'tags',
    slug: string,
    options: GitHubReadOptions,
  ): Promise<readonly string[]> {
    const ownerRepo = parseRepositorySlug(slug)
    // One token resolution per fetch, and none at all on a cache hit.
    return this.loadCached<readonly string[]>(`${kind}:${ownerRepo}`, options.refresh === true, async () => {
      const token = await this.resolveToken()
      const names: string[] = []
      for (let page = 1; page <= GITHUB_LIST_MAX_PAGES; page += 1) {
        const url = `${this.baseUrl}/repos/${ownerRepo}/${kind}?per_page=${GITHUB_LIST_PAGE_SIZE}&page=${page}`
        const request: GitHubRequestOptions = { token }
        if (options.signal !== undefined) request.signal = options.signal
        const body = await githubFetchWithRetry(this.fetchImpl, url, request)
        const data = parseGitHubJson(body.text, url)
        if (!Array.isArray(data)) {
          throw new MarketError('github/bad-response', `The GitHub ${kind} response is not an array.`, { path: url })
        }
        for (const raw of data) {
          const name = refName(raw)
          if (name !== null) names.push(name)
        }
        // A short page means the server has no further entries to return.
        if (data.length < GITHUB_LIST_PAGE_SIZE) break
      }
      return names
    })
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Read the `name` of one branch/tag listing entry (null when malformed). */
function refName(raw: unknown): string | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || raw.name.length === 0) return null
  return raw.name
}

/** Map one GitHub search result object onto the client-safe summary. */
function toRepoSummary(raw: unknown): GitHubRepoSummary | null {
  if (!isObject(raw) || typeof raw.full_name !== 'string') return null
  const fullName = raw.full_name
  const name = typeof raw.name === 'string' ? raw.name : fullName
  const description = typeof raw.description === 'string' ? raw.description : null
  const stars = typeof raw.stargazers_count === 'number' ? raw.stargazers_count : 0
  const updatedAt = typeof raw.updated_at === 'string' ? raw.updated_at : null
  const url = typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${fullName}`
  const cloneUrl = typeof raw.clone_url === 'string' ? raw.clone_url : `${url}.git`
  return { repository: fullName, name, description, stars, updatedAt, url, cloneUrl }
}
