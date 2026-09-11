/**
 * Unit coverage of the GitHub read-only cache and rate-limit backoff, both of
 * which live at the {@link GitHubMarket} method layer:
 *
 * - the 10-minute TTL cache of all five read-only requests (search, repository
 *   metadata, branches, tags, README), the explicit `refresh` bypass and
 *   `clearCache()`;
 * - the single backoff retry of a throttled response (wait <= 5 s), its refusal
 *   above that window, and the `retryAfterMs` / `resetAt` details every
 *   surfaced rate-limit failure carries.
 *
 * Every network hop is a stub, so no test depends on GitHub.
 */

import { describe, expect, it, vi } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import {
  GITHUB_CACHE_TTL_MS,
  GITHUB_RATE_LIMIT_MAX_BACKOFF_MS,
  GitHubMarket,
  type FetchInit,
  type FetchLike,
  type FetchResponse,
} from '../src/host/market/github.ts'

/** One stubbed GitHub response. */
interface RequestStub {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly rawText?: string
  readonly body?: unknown
}

const SLUG = 'owner/sample-plugin'

/** Build an injectable fetch serving scripted routes and counting every call. */
function stubGitHub(
  handler: (url: string, init?: FetchInit) => RequestStub,
): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url)
    const stub = handler(url, init)
    return {
      status: stub.status,
      ok: stub.status >= 200 && stub.status < 300,
      headers: { get: (name: string) => stub.headers?.[name.toLowerCase()] ?? null },
      text: async () => stub.rawText ?? JSON.stringify(stub.body ?? {}),
    } satisfies FetchResponse
  }
  return { fetchImpl, urls }
}

/** Search page body carrying a name marker for cache probes. */
function searchBody(marker: string): unknown {
  return {
    total_count: 1,
    items: [{ full_name: SLUG, name: marker, stargazers_count: 1 }],
  }
}

/** Repository metadata body carrying a name marker for cache probes. */
function metaBody(marker: string): unknown {
  return { full_name: SLUG, name: marker, default_branch: 'main' }
}

/** One branch/tag listing page with `count` entries. */
function refList(count: number, prefix: string): unknown {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}` }))
}

/** Await a rejection and hand back the asserted {@link MarketError}. */
async function caughtCode(promise: Promise<unknown>): Promise<MarketError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    return error as MarketError
  }
  throw new Error('expected the call to reject, but it resolved')
}

/**
 * Run one body with a mocked wall clock and no leaked time offset: the clock is
 * re-anchored on a snapshot taken BEFORE the timer swap, so advancing it inside
 * the body can never shift the real clock for later tests.
 */
async function withMockedClock(body: (advanceBy: (ms: number) => void) => Promise<void>): Promise<void> {
  const anchor = Date.now()
  vi.useFakeTimers()
  try {
    vi.setSystemTime(anchor)
    await body((ms) => vi.setSystemTime(Date.now() + ms))
  } finally {
    vi.useRealTimers()
  }
}

describe('GitHubMarket read-only TTL cache', () => {
  it('caches the branch and tag listings per resource', async () => {
    let calls = 0
    const { fetchImpl, urls } = stubGitHub((url) => {
      calls += 1
      return { status: 200, body: refList(2, url.includes('/tags') ? 'tag-' : 'branch-') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.branches(SLUG)
    await market.branches(SLUG)
    await market.tags(SLUG)
    await market.tags(SLUG)
    // One fetch per resource: the branch entry never answers a tag call.
    expect(calls).toBe(2)
    expect(urls[0]).toContain('/branches?per_page=100&page=1')
    expect(urls[1]).toContain('/tags?per_page=100&page=1')
  })

  it('caches the README text and caches a missing README as a real null answer', async () => {
    const present = stubGitHub(() => ({ status: 200, rawText: '# Readme' }))
    const market = new GitHubMarket({ fetchImpl: present.fetchImpl, tokenProvider: () => null })
    expect(await market.readme(SLUG)).toBe('# Readme')
    expect(await market.readme(SLUG)).toBe('# Readme')
    expect(present.urls).toHaveLength(1)
    const absent = stubGitHub(() => ({ status: 404, rawText: '404: Not Found' }))
    const missing = new GitHubMarket({ fetchImpl: absent.fetchImpl, tokenProvider: () => null })
    expect(await missing.readme(SLUG)).toBeNull()
    expect(await missing.readme(SLUG)).toBeNull()
    // The 404 answer is remembered: a missing README is not re-probed per call.
    expect(absent.urls).toHaveLength(1)
  })

  it('keys the README entry by resource so it never answers the metadata call', async () => {
    const { fetchImpl } = stubGitHub((url) => {
      if (url.includes('/readme')) return { status: 200, rawText: '# Raw' }
      return { status: 200, body: metaBody('meta') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect((await market.repositoryMeta(SLUG)).name).toBe('meta')
    expect(await market.readme(SLUG)).toBe('# Raw')
    // A second metadata call still answers with metadata, not with the README.
    expect((await market.repositoryMeta(SLUG)).name).toBe('meta')
  })

  it('keys the search entry by page, per_page, keywords and sort parameters', async () => {
    const { fetchImpl, urls } = stubGitHub(() => ({ status: 200, body: searchBody('hit') }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    // The same call twice is one fetch; anything differing fetches its own page.
    await market.search({ keywords: 'cool', page: 1, perPage: 20 })
    await market.search({ keywords: 'cool', page: 1, perPage: 20 })
    expect(urls).toHaveLength(1)
    await market.search({ keywords: 'cool', page: 2, perPage: 20 })
    await market.search({ keywords: 'cool', page: 1, perPage: 30 })
    await market.search({ keywords: 'other', page: 1, perPage: 20 })
    expect(urls).toHaveLength(4)
    // A sorted query is its own entry...
    await market.search({ keywords: 'cool', page: 1, perPage: 20, sort: 'stars' })
    expect(urls).toHaveLength(5)
    // ...and `sort` without an order IS `order=desc` (the query GitHub is sent),
    // so this call is served from the entry the previous one just filled.
    await market.search({ keywords: 'cool', page: 1, perPage: 20, sort: 'stars', order: 'desc' })
    expect(urls).toHaveLength(5)
    // The reverse order is a different query again.
    await market.search({ keywords: 'cool', page: 1, perPage: 20, sort: 'stars', order: 'asc' })
    expect(urls).toHaveLength(6)
  })

  it('bypasses the cache on an explicit refresh and refills it with the fresh answer', async () => {
    let calls = 0
    const { fetchImpl, urls } = stubGitHub(() => {
      calls += 1
      return { status: 200, body: searchBody(`marker-${calls}`) }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect((await market.search({ keywords: 'cool' })).items[0]?.name).toBe('marker-1')
    expect((await market.search({ keywords: 'cool' })).items[0]?.name).toBe('marker-1')
    expect(urls).toHaveLength(1)
    expect((await market.search({ keywords: 'cool', refresh: true })).items[0]?.name).toBe('marker-2')
    expect(urls).toHaveLength(2)
    // The refreshed answer is what the next ordinary call is served from.
    expect((await market.search({ keywords: 'cool' })).items[0]?.name).toBe('marker-2')
    expect(urls).toHaveLength(2)
  })

  it('bypasses the cache on refresh for every repository detail call', async () => {
    let metaCalls = 0
    let readmeCalls = 0
    let refCalls = 0
    const { fetchImpl, urls } = stubGitHub((url) => {
      if (url.includes('/readme')) {
        readmeCalls += 1
        return { status: 200, rawText: `# ${readmeCalls}` }
      }
      if (url.includes('/branches') || url.includes('/tags')) {
        refCalls += 1
        return { status: 200, body: refList(1, 'r-') }
      }
      metaCalls += 1
      return { status: 200, body: metaBody(`meta-${metaCalls}`) }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.repositoryMeta(SLUG)
    await market.repositoryMeta(SLUG, { refresh: true })
    expect((await market.repositoryMeta(SLUG)).name).toBe('meta-2')
    expect(await market.readme(SLUG)).toBe('# 1')
    expect(await market.readme(SLUG, { refresh: true })).toBe('# 2')
    await market.branches(SLUG)
    await market.branches(SLUG, { refresh: true })
    await market.tags(SLUG)
    await market.tags(SLUG, { refresh: true })
    expect(metaCalls).toBe(2)
    expect(readmeCalls).toBe(2)
    expect(refCalls).toBe(4)
    // Eight calls, eight network hops: only the two refreshes of each resource
    // pair left the cache in place for the ordinary calls.
    expect(urls).toHaveLength(8)
  })

  it('invalidates every cached entry in one call', async () => {
    let calls = 0
    const { fetchImpl, urls } = stubGitHub((url) => {
      calls += 1
      if (url.includes('/readme')) return { status: 200, rawText: '# Raw' }
      if (url.includes('/branches') || url.includes('/tags')) return { status: 200, body: refList(1, 'r-') }
      if (url.includes('/search/')) return { status: 200, body: searchBody('hit') }
      return { status: 200, body: metaBody('meta') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    // Five read-only requests, five distinct cache entries.
    await market.search({})
    await market.repositoryMeta(SLUG)
    await market.branches(SLUG)
    await market.tags(SLUG)
    await market.readme(SLUG)
    expect(calls).toBe(5)
    // Nothing is re-fetched while the cache holds.
    await market.search({})
    await market.repositoryMeta(SLUG)
    await market.branches(SLUG)
    await market.tags(SLUG)
    await market.readme(SLUG)
    expect(calls).toBe(5)
    expect(market.clearCache()).toBe(5)
    expect(market.clearCache()).toBe(0)
    await market.search({})
    await market.repositoryMeta(SLUG)
    await market.branches(SLUG)
    await market.tags(SLUG)
    await market.readme(SLUG)
    expect(calls).toBe(10)
    expect(urls).toHaveLength(10)
  })

  it('resolves the token once per fetch and not at all on a cache hit', async () => {
    let resolutions = 0
    const { fetchImpl, urls } = stubGitHub(() => ({ status: 200, body: refList(1, 'r-') }))
    const market = new GitHubMarket({
      fetchImpl,
      tokenProvider: async () => {
        resolutions += 1
        return null
      },
    })
    await market.branches(SLUG)
    await market.branches(SLUG)
    await market.tags(SLUG)
    expect(urls).toHaveLength(2)
    expect(resolutions).toBe(2)
  })

  it('never caches a failure: the next call reaches GitHub again', async () => {
    let calls = 0
    const { fetchImpl, urls } = stubGitHub(() => {
      calls += 1
      return calls === 1 ? { status: 404 } : { status: 200, body: metaBody('meta') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect((await caughtCode(market.repositoryMeta(SLUG))).code).toBe('github/not-found')
    expect((await market.repositoryMeta(SLUG)).name).toBe('meta')
    expect(urls).toHaveLength(2)
  })

  // --- Expiry coverage, deliberately LAST in this file -------------------
  // These two advance the mocked wall clock (by a full TTL, so by necessity
  // "into the future"). Vitest's mocked clock keeps that offset for the rest of
  // the file, which would make every cache entry written afterwards look
  // instantly expired — hence the placement, and hence `withMockedClock`'s
  // explicit re-anchor before each body.

  it('serves a repeated search from cache and refetches once the TTL expired', async () => {
    let marker = 'first'
    const { fetchImpl, urls } = stubGitHub(() => ({ status: 200, body: searchBody(marker) }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await withMockedClock(async (advanceBy) => {
      expect((await market.search({ keywords: 'cool' })).items[0]?.name).toBe('first')
      expect(urls).toHaveLength(1)
      marker = 'second'
      // Just inside the TTL the cached page is served, and it survives being
      // read again; one tick past the TTL the answer comes from GitHub.
      advanceBy(GITHUB_CACHE_TTL_MS - 1)
      expect((await market.search({ keywords: 'cool' })).items[0]?.name).toBe('first')
      expect(urls).toHaveLength(1)
      advanceBy(2)
      expect((await market.search({ keywords: 'cool' })).items[0]?.name).toBe('second')
      expect(urls).toHaveLength(2)
    })
  })

  it('serves repeated repository metadata from cache until the TTL expired', async () => {
    let marker = 'first'
    const { fetchImpl, urls } = stubGitHub(() => ({ status: 200, body: metaBody(marker) }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await withMockedClock(async (advanceBy) => {
      expect((await market.repositoryMeta(SLUG)).name).toBe('first')
      marker = 'second'
      expect((await market.repositoryMeta(SLUG)).name).toBe('first')
      expect(urls).toHaveLength(1)
      advanceBy(GITHUB_CACHE_TTL_MS + 1)
      expect((await market.repositoryMeta(SLUG)).name).toBe('second')
      expect(urls).toHaveLength(2)
    })
  })
})

describe('GitHubMarket rate-limit backoff', () => {
  it('retries once when GitHub reports a wait inside the backoff window', async () => {
    const perResource = new Map<string, number>()
    const { fetchImpl, urls } = stubGitHub((url, init) => {
      const kind = url.includes('/readme') ? 'readme' : 'meta'
      const seen = (perResource.get(kind) ?? 0) + 1
      perResource.set(kind, seen)
      expect(init?.headers?.authorization).toBe('Bearer secret-token-abc')
      // The first hop of each resource is throttled with a short wait.
      if (seen === 1) return { status: 429, headers: { 'retry-after': '0.01' } }
      if (kind === 'readme') return { status: 200, rawText: '# Recovered' }
      return { status: 200, body: metaBody('recovered') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => 'secret-token-abc' })
    expect(await market.readme(SLUG)).toBe('# Recovered')
    expect((await market.repositoryMeta(SLUG)).name).toBe('recovered')
    // Two resources, one throttled hop and one retry each, never a second retry.
    expect(perResource.get('readme')).toBe(2)
    expect(perResource.get('meta')).toBe(2)
    expect(urls).toHaveLength(4)
  })

  it('does not retry a wait beyond the backoff window and reports it in the details', async () => {
    const retryAfterMs = GITHUB_RATE_LIMIT_MAX_BACKOFF_MS + 5_000
    const { fetchImpl, urls } = stubGitHub(() => ({ status: 429, headers: { 'retry-after': String(retryAfterMs / 1000) } }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await caughtCode(market.search({}))
    expect(error.code).toBe('github/rate-limit')
    expect(urls).toHaveLength(1)
    expect(error.details.retryAfterMs).toBe(retryAfterMs)
    // The response reported no reset instant, so none is invented.
    expect(error.details.resetAt).toBeUndefined()
  })

  it('does not retry a throttled response that reports no usable wait', async () => {
    const { fetchImpl, urls } = stubGitHub(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await caughtCode(market.repositoryMeta(SLUG))
    expect(error.code).toBe('github/rate-limit')
    expect(urls).toHaveLength(1)
    expect(error.details).toEqual({})
  })

  it('carries the reset instant and the derived wait of a 403 rate limit', async () => {
    // A reset 30 s out is well beyond the backoff window: no retry, and the
    // surfaced failure carries both the instant and the derived wait.
    const resetSeconds = Math.floor(Date.now() / 1000) + 30
    const { fetchImpl, urls } = stubGitHub(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) },
    }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await caughtCode(market.readme(SLUG))
    expect(error.code).toBe('github/rate-limit')
    expect(error.details.resetAt).toBe(new Date(resetSeconds * 1000).toISOString())
    const retryAfterMs = error.details.retryAfterMs
    expect(typeof retryAfterMs).toBe('number')
    expect(retryAfterMs as number).toBeGreaterThan(GITHUB_RATE_LIMIT_MAX_BACKOFF_MS)
    expect(urls).toHaveLength(1)
  })

  it('retries a 403 rate limit whose derived wait fits the window, keeping the code', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 2
    let calls = 0
    const { fetchImpl, urls } = stubGitHub(() => {
      calls += 1
      if (calls === 1) {
        return { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) } }
      }
      return { status: 200, rawText: '# Recovered' }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect(await market.readme(SLUG)).toBe('# Recovered')
    // The retry succeeded, so the backoff never surfaced as an error at all.
    expect(calls).toBe(2)
    expect(urls).toHaveLength(2)
  })

  it('reads an HTTP-date retry-after as a wait duration', async () => {
    const retryAfterMs = 4_000
    const { fetchImpl } = stubGitHub(() => ({
      status: 429,
      headers: { 'retry-after': new Date(Date.now() + retryAfterMs).toUTCString() },
    }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await caughtCode(market.branches(SLUG))
    const wait = error.details.retryAfterMs
    expect(typeof wait).toBe('number')
    expect(wait as number).toBeGreaterThan(0)
    expect(wait as number).toBeLessThanOrEqual(GITHUB_RATE_LIMIT_MAX_BACKOFF_MS)
  })

  it('retries a throttled listing page without paging past the last page', async () => {
    let calls = 0
    const { fetchImpl, urls } = stubGitHub((url) => {
      calls += 1
      if (url.includes('page=1') && calls === 1) return { status: 429, headers: { 'retry-after': '0.01' } }
      return { status: 200, body: refList(3, 'b-') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect(await market.branches(SLUG)).toEqual(['b-0', 'b-1', 'b-2'])
    expect(urls).toHaveLength(2)
  })

  it('never retries an auth failure', async () => {
    const { fetchImpl, urls } = stubGitHub(() => ({ status: 403 }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await caughtCode(market.search({}))
    expect(error.code).toBe('github/auth')
    expect(urls).toHaveLength(1)
  })
})
