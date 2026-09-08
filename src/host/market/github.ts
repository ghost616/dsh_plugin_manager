/**
 * GitHub integration for the plugin market: repository search plus shared
 * low-level HTTP primitives used by the preview pipeline. Credentials are
 * resolved per request through an injectable {@link TokenProvider} (defaults
 * to the `DSH_GITHUB_TOKEN`/`GITHUB_TOKEN` environment variables) and only
 * live in request headers at runtime — they are never persisted, logged or
 * cached on results. Network/rate-limit/auth failures map to stable
 * `github/*` codes.
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
    accept: 'application/vnd.github+json',
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
    throw new MarketError('github/network', `The GitHub request failed at the network level.`, { path: url, cause: error })
  }
  const status = response.status
  if (status >= 200 && status < 300) {
    return { text: await readBody(response, url), headers: collectHeaders(response) }
  }
  const headersInfo = collectHeaders(response)
  throw errorFromStatus(status, headersInfo, url)
}

async function readBody(response: FetchResponse, url: string): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    throw new MarketError('github/bad-response', 'The GitHub response body could not be read.', { path: url, cause: error })
  }
}

/** Map a non-2xx GitHub status onto the stable github/* failure vocabulary. */
function errorFromStatus(status: number, headers: GitHubResponseHeaders, url: string): MarketError {
  const reset = headers.rateLimitReset
  const remaining = headers.rateLimitRemaining
  const retryAfter = headers.retryAfter
  if (status === 401) {
    return new MarketError('github/auth', 'The GitHub request was rejected for invalid credentials.', { path: url })
  }
  if (status === 429 || (status === 403 && (remaining === '0' || reset !== null || retryAfter !== null))) {
    const when = retryAfter
      ? `retry-after ${retryAfter}s`
      : reset
        ? `rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}`
        : 'retry later'
    return new MarketError('github/rate-limit', `The GitHub API rate limit was exceeded (${when}). Configure a token or wait.`, { path: url })
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
}

/** Repository never offered as an install source: the harness's own checkout. */
export const SEARCH_EXCLUDED_REPOS: readonly string[] = ['deepseek-ai/deepseek-harness']

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
 */
export class GitHubMarket {
  private readonly fetchImpl: FetchLike
  private readonly tokenProvider?: TokenProvider
  private readonly baseUrl: string

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
    const request: GitHubRequestOptions = { token: await this.resolveToken() }
    if (options.signal !== undefined) request.signal = options.signal
    const body = await githubFetch(this.fetchImpl, url, request)
    const data = parseGitHubJson(body.text, url)
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

  /** Repository metadata (also resolves the default branch) for one slug. */
  async repositoryMeta(slug: string, signal?: AbortSignal): Promise<GitHubRepoMeta> {
    const ownerRepo = parseRepositorySlug(slug)
    const url = `${this.baseUrl}/repos/${ownerRepo}`
    const request: GitHubRequestOptions = { token: await this.resolveToken() }
    if (signal !== undefined) request.signal = signal
    const body = await githubFetch(this.fetchImpl, url, request)
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
  }

  /** Resolve the runtime token (anonymous when none is configured). */
  async resolveToken(): Promise<string | null> {
    if (!this.tokenProvider) return null
    const token = await this.tokenProvider()
    return token && token.length > 0 ? token : null
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
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
