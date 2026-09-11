/**
 * Lizhu independent verification: GitHub read-only TTL cache / rate-limit
 * backoff / credential-seam token source.
 *
 * This file deliberately does NOT restate the assertions of
 * `tests/market-github-cache.spec.ts` and `tests/market-token.spec.ts`; it
 * targets the gaps those suites leave open:
 *
 * - a cache hit must not consult the token source at all (even when the token
 *   was cleared between the two calls);
 * - a paginated listing resolves the token once per fetch, not once per page
 *   (an EARLIER version of this file matched `page=1` with `includes`, which
 *   also matched `page=10` and looped to the 5-page cap - the fixed stub below
 *   matches the exact query parameter);
 * - the backoff retry is hard-capped at exactly one retry (two hops total) and
 *   the reported wait at the window edge (retry-after exactly 5s) still retries;
 * - a wait beyond the window does not retry;
 * - cancellation during the backoff wait: no retry, github/network surfaced;
 * - malformed rate-limit headers invent no details; 401/500 never retry;
 * - the search cache key carries the exclusion set; absent options and an
 *   explicit empty options object share one entry;
 * - readme refresh refills the entry; clearCache drops without wedging;
 * - malformed / failing credential seams degrade to anonymous;
 * - the exact TTL boundary (written + TTL is already expired).
 *
 * Clock note: the two clock-driven cases (the retry-after=5s edge and the TTL
 * boundary) are the LAST two cases in this file, each swaps the clock inside the
 * case and restores it in a `finally`, and each builds its market instance
 * BEFORE the swap. Nothing earlier can therefore be polluted by a clock offset
 * (the trap the checked-in suite documents in its own footer comment).
 */

import { Context } from '@deepseek-ai/cordis'
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
import {
  credentialsServiceOf,
  credentialsTokenProvider,
  hasCredentialsSeam,
  requireCredentials,
  resolveGitHubToken,
} from '../src/host/market/token.ts'

const SLUG = 'lizhu/probe-plugin'

interface Stub {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly rawText?: string
  readonly body?: unknown
}

/** Record every request (url + init, incl. the authorization header). */
function recorder(handler: (url: string, init: FetchInit | undefined, call: number) => Stub): {
  fetchImpl: FetchLike
  calls: { url: string; init: FetchInit | undefined }[]
  auth: (string | undefined)[]
} {
  const calls: { url: string; init: FetchInit | undefined }[] = []
  const auth: (string | undefined)[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    auth.push(init?.headers?.authorization)
    const stub = handler(url, init, calls.length)
    return {
      status: stub.status,
      ok: stub.status >= 200 && stub.status < 300,
      headers: { get: (name: string) => stub.headers?.[name.toLowerCase()] ?? null },
      text: async () => stub.rawText ?? JSON.stringify(stub.body ?? {}),
    } satisfies FetchResponse
  }
  return { fetchImpl, calls, auth }
}

async function catchError(run: () => Promise<unknown>): Promise<MarketError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    return error as MarketError
  }
  throw new Error('expected the call to reject, but it resolved')
}

function meta(marker: string): unknown {
  return { full_name: SLUG, name: marker, default_branch: 'main' }
}

function refs(count: number, prefix: string): unknown {
  return Array.from({ length: count }, (_, i) => ({ name: `${prefix}${i}` }))
}

/** Exact page-number match, so page=1 never matches page=10. */
function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get('page'))
}

describe('independent check: cache hits and token resolution', () => {
  it('never consults the token source on a cache hit, even after the token was cleared', async () => {
    let token: string | null = 'lizhu-token-1'
    let resolutions = 0
    const { fetchImpl, calls, auth } = recorder(() => ({ status: 200, body: refs(1, 'b-') }))
    const market = new GitHubMarket({
      fetchImpl,
      tokenProvider: () => {
        resolutions += 1
        return token
      },
    })
    await market.branches(SLUG)
    token = null
    // Second call is served from cache: the provider must not run again and the
    // Authorization header must not be renegotiated.
    await market.branches(SLUG)
    expect(calls).toHaveLength(1)
    expect(resolutions).toBe(1)
    expect(auth).toEqual(['Bearer lizhu-token-1'])
  })

  it('resolves the token once per listing fetch, reusing it on page two', async () => {
    let resolutions = 0
    const { fetchImpl, calls, auth } = recorder((url) =>
      pageOf(url) === 1 ? { status: 200, body: refs(100, 'p1-') } : { status: 200, body: refs(3, 'p2-') },
    )
    const market = new GitHubMarket({
      fetchImpl,
      tokenProvider: () => {
        resolutions += 1
        return `token-${resolutions}`
      },
    })
    const names = await market.branches(SLUG)
    // Page one is full (100 = the page size), page two is short: paging stops.
    expect(calls).toHaveLength(2)
    expect(names).toHaveLength(103)
    expect(resolutions).toBe(1)
    expect(auth).toEqual(['Bearer token-1', 'Bearer token-1'])
  })

  it('treats an explicit empty options object exactly like the absent one', async () => {
    const { fetchImpl, calls } = recorder(() => ({ status: 200, body: refs(1, 'b-') }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.tags(SLUG)
    await market.tags(SLUG, {})
    expect(calls).toHaveLength(1)
  })
})

describe('independent check: retry cap and backoff window boundaries', () => {
  it('retries exactly once when every hop keeps answering 429', async () => {
    const { fetchImpl, calls } = recorder(() => ({ status: 429, headers: { 'retry-after': '0.01' } }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await catchError(() => market.search({ keywords: 'lizhu' }))
    expect(error.code).toBe('github/rate-limit')
    expect(calls).toHaveLength(2)
    expect(typeof error.details.retryAfterMs).toBe('number')
  })

  it('retries a 403 whose reset-derived wait is inside the window', async () => {
    // A reset 2s out stays under the 5s window even after the few ms the real
    // clock advances between capturing the instant and reading the header.
    const resetSeconds = Math.floor(Date.now() / 1000) + 2
    let hop = 0
    const { fetchImpl, calls } = recorder(() => {
      hop += 1
      if (hop === 1) {
        return { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) } }
      }
      return { status: 200, body: meta('recovered-inside') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const value = await market.repositoryMeta(SLUG)
    expect(value.name).toBe('recovered-inside')
    expect(calls).toHaveLength(2)
  })

  it('does not retry a 403 whose reset-derived wait is 30s', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 30
    const { fetchImpl, calls } = recorder(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) },
    }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await catchError(() => market.branches(SLUG))
    expect(error.code).toBe('github/rate-limit')
    expect(calls).toHaveLength(1)
    expect(error.details.retryAfterMs as number).toBeGreaterThan(GITHUB_RATE_LIMIT_MAX_BACKOFF_MS)
  })

  it('does not retry when the caller cancels during the backoff wait', async () => {
    const controller = new AbortController()
    const { fetchImpl, calls } = recorder(() => ({ status: 429, headers: { 'retry-after': '0.2' } }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    setTimeout(() => controller.abort(new Error('lizhu-cancel')), 10)
    const error = await catchError(() => market.repositoryMeta(SLUG, { signal: controller.signal }))
    expect(error.code).toBe('github/network')
    expect(calls).toHaveLength(1)
  })

  it('invents no details from malformed rate-limit headers and makes one hop only', async () => {
    const { fetchImpl, calls } = recorder(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'not-a-number', 'retry-after': '   ' },
    }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await catchError(() => market.tags(SLUG))
    expect(error.code).toBe('github/rate-limit')
    expect(error.details).toEqual({})
    expect(calls).toHaveLength(1)
  })

  it('never retries 401 or 500, keeping their own codes', async () => {
    const unauthorized = recorder(() => ({ status: 401 }))
    const marketA = new GitHubMarket({ fetchImpl: unauthorized.fetchImpl, tokenProvider: () => 'x' })
    expect((await catchError(() => marketA.search({ keywords: 'a' }))).code).toBe('github/auth')
    expect(unauthorized.calls).toHaveLength(1)

    const server = recorder(() => ({ status: 500, headers: { 'retry-after': '0.01' } }))
    const marketB = new GitHubMarket({ fetchImpl: server.fetchImpl, tokenProvider: () => null })
    expect((await catchError(() => marketB.search({ keywords: 'b' }))).code).toBe('github/network')
    expect(server.calls).toHaveLength(1)
  })
})

describe('independent check: cache keys, clearing and failure non-caching', () => {
  it('carries the exclusion set inside the search cache key', async () => {
    const { fetchImpl, calls } = recorder(() => ({
      status: 200,
      body: { total_count: 1, items: [{ full_name: SLUG, name: 'hit' }] },
    }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.search({ keywords: 'x', exclude: ['a/one'] })
    await market.search({ keywords: 'x', exclude: ['a/one'] })
    await market.search({ keywords: 'x', exclude: ['a/two'] })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('-repo%3Aa%2Fone')
    expect(calls[1]?.url).toContain('-repo%3Aa%2Ftwo')
  })

  it('never lets one slug answer for another', async () => {
    const { fetchImpl, calls } = recorder((url) =>
      url.includes('one') ? { status: 200, body: meta('slug-one') } : { status: 200, body: meta('slug-two') },
    )
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect((await market.repositoryMeta('lizhu/one')).name).toBe('slug-one')
    expect((await market.repositoryMeta('lizhu/two')).name).toBe('slug-two')
    expect((await market.repositoryMeta('lizhu/one')).name).toBe('slug-one')
    expect(calls).toHaveLength(2)
  })

  it('does not cache a failing readme (500) and re-fetches next time', async () => {
    let hop = 0
    const { fetchImpl, calls } = recorder(() => {
      hop += 1
      return hop === 1 ? { status: 500 } : { status: 200, rawText: '# ok' }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect((await catchError(() => market.readme(SLUG))).code).toBe('github/network')
    expect(await market.readme(SLUG)).toBe('# ok')
    expect(calls).toHaveLength(2)
  })

  it('serves the refreshed readme value to the following ordinary call', async () => {
    let hop = 0
    const { fetchImpl, calls } = recorder(() => {
      hop += 1
      return { status: 200, rawText: `# v${hop}` }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    expect(await market.readme(SLUG)).toBe('# v1')
    expect(await market.readme(SLUG, { refresh: true })).toBe('# v2')
    expect(await market.readme(SLUG)).toBe('# v2')
    expect(calls).toHaveLength(2)
  })

  it('reports the dropped entry count and keeps working afterwards', async () => {
    let hop = 0
    const { fetchImpl, calls } = recorder((url) => {
      hop += 1
      if (url.includes('/readme')) return { status: 200, rawText: '# r' }
      return { status: 200, body: meta(`m${hop}`) }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.repositoryMeta(SLUG)
    await market.readme(SLUG)
    expect(market.clearCache()).toBe(2)
    expect(market.clearCache()).toBe(0)
    expect((await market.repositoryMeta(SLUG)).name).toBe('m3')
    expect(calls).toHaveLength(3)
  })
})

describe('independent check: the new error code default message', () => {
  it('renders the operator copy for github/token-unavailable when no message is given', () => {
    const error = new MarketError('github/token-unavailable')
    // This code was the only missing key of the DEFAULT_MESSAGE record (a
    // TS2741 until it was added): without it the constructor renders undefined.
    expect(error.code).toBe('github/token-unavailable')
    expect(error.message).toBe(
      'This deployment has no credential seam, so the GitHub token cannot be read or written.',
    )
    expect(error.details).toEqual({})
  })

  it('keeps every other code off the undefined-message path', () => {
    const codes = ['github/auth', 'github/rate-limit', 'github/network', 'github/not-found', 'github/bad-response', 'github/bad-request'] as const
    for (const code of codes) {
      const message = new MarketError(code).message
      expect(typeof message).toBe('string')
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('undefined')
    }
  })
})
describe('independent check: token source shapes and boundaries', () => {
  /**
   * A Context-shaped double answering the inject-free service lookup
   * (`ctx.get('credentials')`) the token module reads through. A double that
   * only carried a `credentials` PROPERTY would test a path production never
   * takes: cordis resolves services through the lookup, and the property read
   * throws on a composition that never declared the accessor.
   */
  function ctxWithCredentials(value: unknown): Context {
    return { get: (name: string) => (name === 'credentials' ? value : undefined) } as unknown as Context
  }

  it('treats a credentials object without a resolve function as unmounted', async () => {
    const malformed = ctxWithCredentials({ describe: async () => ({ configured: true }) })
    expect(hasCredentialsSeam(malformed)).toBe(false)
    expect(credentialsServiceOf(malformed)).toBeNull()
    expect(await resolveGitHubToken(malformed)).toBeNull()
    expect(await credentialsTokenProvider(malformed)()).toBeNull()
    expect((await catchError(async () => requireCredentials(malformed))).code).toBe('github/token-unavailable')
  })

  it('treats null / string / array / number credentials as unmounted too', async () => {
    for (const value of [null, 'seam', [], 42]) {
      const ctx = ctxWithCredentials(value)
      expect(hasCredentialsSeam(ctx)).toBe(false)
      expect(await resolveGitHubToken(ctx)).toBeNull()
    }
  })

  it('degrades to anonymous with one diagnostic when the seam throws', async () => {
    const warnings: string[] = []
    let asked = 0
    const ctx = ctxWithCredentials({
      async resolve() {
        asked += 1
        throw new Error('seam down')
      },
      async describe() {
        return { configured: false, writable: true }
      },
    })
    expect(await resolveGitHubToken(ctx, { onResolveError: (m) => warnings.push(m) })).toBeNull()
    // The head reference threw, so the fallback reference is never consulted.
    expect(asked).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('seam down')
  })

  it('fails requireCredentials on every call (no launch-environment fallback)', async () => {
    const bare = new Context()
    const first = await catchError(async () => requireCredentials(bare))
    const second = await catchError(async () => requireCredentials(bare))
    expect(first.code).toBe('github/token-unavailable')
    expect(second.code).toBe('github/token-unavailable')
    expect(first.message).toContain('no credential seam')
  })
})

describe('independent check: GitHubReadOptions.signal attachment', () => {
  it('attaches an already-aborted signal to the network hop and caches nothing', async () => {
    const controller = new AbortController()
    controller.abort(new Error('lizhu-pre-aborted'))
    let seen: AbortSignal | undefined
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init?.signal
      // A real fetch rejects a pre-aborted signal before any I/O.
      if (init?.signal?.aborted === true) throw new Error('aborted by caller')
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify(meta('never')),
      } satisfies FetchResponse
    }
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const error = await catchError(() => market.repositoryMeta(SLUG, { signal: controller.signal }))
    expect(error.code).toBe('github/network')
    expect(seen).toBe(controller.signal)
    // The failed read was not cached: an ordinary call now reaches the network.
    expect((await market.repositoryMeta(SLUG)).name).toBe('never')
  })

  it('omits the signal on the hop when no options were given (exactOptionalPropertyTypes)', async () => {
    let sawSignal: unknown = 'sentinel'
    const fetchImpl: FetchLike = async (_url, init) => {
      sawSignal = init?.signal
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => JSON.stringify(meta('plain')),
      } satisfies FetchResponse
    }
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.repositoryMeta(SLUG)
    expect(sawSignal).toBeUndefined()
  })
})
// --- Clock-driven cases, deliberately last in this file --------------------

describe('independent check: backoff edge and exact TTL boundary', () => {
  it('retries a retry-after of exactly the 5s window edge (mocked clock)', async () => {
    let hop = 0
    const { fetchImpl, calls } = recorder(() => {
      hop += 1
      if (hop === 1) return { status: 429, headers: { 'retry-after': '5' } }
      return { status: 200, body: meta('edge-recovered') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const anchor = Date.now()
    vi.useFakeTimers()
    try {
      // Pin the clock first: the stub's `retry-after: 5` must parse to EXACTLY
      // the 5000 ms window edge (with the real clock a stray millisecond would
      // silently turn this into a 4999 ms case).
      vi.setSystemTime(anchor)
      const pending = market.repositoryMeta(SLUG)
      await vi.advanceTimersByTimeAsync(GITHUB_RATE_LIMIT_MAX_BACKOFF_MS + 1)
      const value = await pending
      expect(value.name).toBe('edge-recovered')
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serves TTL-1ms from cache and treats the exact TTL instant as expired (mocked clock)', async () => {
    let hop = 0
    const { fetchImpl, calls } = recorder(() => {
      hop += 1
      return { status: 200, body: meta(`v${hop}`) }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const anchor = Date.now()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(anchor)
      expect((await market.repositoryMeta(SLUG)).name).toBe('v1')
      vi.setSystemTime(anchor + GITHUB_CACHE_TTL_MS - 1)
      expect((await market.repositoryMeta(SLUG)).name).toBe('v1')
      expect(calls).toHaveLength(1)
      // Exactly at the TTL instant `expiresAt > now` no longer holds: expired.
      vi.setSystemTime(anchor + GITHUB_CACHE_TTL_MS)
      expect((await market.repositoryMeta(SLUG)).name).toBe('v2')
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})