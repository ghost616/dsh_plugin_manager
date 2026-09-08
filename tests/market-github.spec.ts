import { describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import {
  GitHubMarket,
  isValidRepositorySlug,
  type FetchInit,
  type FetchLike,
  type FetchResponse,
} from '../src/host/market/github.ts'

/** One stubbed GitHub response route. */
interface Stub {
  status: number
  headers?: Record<string, string>
  body?: unknown
  rawText?: string
}

/** Build an injectable fetch serving fixed routes and recording calls. */
function stubGitHub(
  handler: (url: string, init?: FetchInit) => Stub,
): { fetchImpl: FetchLike; calls: Array<{ url: string; init?: FetchInit }> } {
  const calls: Array<{ url: string; init?: FetchInit }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const stub = handler(url, init)
    return {
      status: stub.status,
      ok: stub.status >= 200 && stub.status < 300,
      headers: { get: (name: string) => stub.headers?.[name.toLowerCase()] ?? null },
      text: async () => stub.rawText ?? JSON.stringify(stub.body ?? {}),
    } satisfies FetchResponse
  }
  return { fetchImpl, calls }
}

function jsonBody(totalCount: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    total_count: totalCount,
    items: [{
      full_name: 'owner/sample-plugin',
      name: 'sample-plugin',
      description: 'A sample dsh plugin',
      stargazers_count: 42,
      updated_at: '2024-05-01T10:00:00Z',
      html_url: 'https://github.com/owner/sample-plugin',
      clone_url: 'https://github.com/owner/sample-plugin.git',
      ...overrides,
    }],
  }
}

async function rejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    expect((error as MarketError).code).toBe(code)
    return
  }
  throw new Error(`expected MarketError with code ${code}, but the promise resolved`)
}

describe('GitHubMarket.search', () => {
  it('maps a successful response onto client-safe summaries', async () => {
    const { fetchImpl, calls } = stubGitHub((url) => {
      expect(url).toContain('/search/repositories')
      expect(url).toContain('topic%3Adsh-plugin')
      // URLSearchParams encodes the space separator as '+'.
      expect(url).toContain('topic%3Adsh-plugin+cool')
      return { status: 200, body: jsonBody(1) }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const page = await market.search({ keywords: 'cool' })
    expect(page.totalCount).toBe(1)
    expect(page.items).toHaveLength(1)
    const item = page.items[0]
    if (item) {
      expect(item.repository).toBe('owner/sample-plugin')
      expect(item.name).toBe('sample-plugin')
      expect(item.description).toBe('A sample dsh plugin')
      expect(item.stars).toBe(42)
      expect(item.updatedAt).toBe('2024-05-01T10:00:00Z')
      expect(item.url).toBe('https://github.com/owner/sample-plugin')
      expect(item.cloneUrl).toBe('https://github.com/owner/sample-plugin.git')
    }
    expect(calls.length).toBe(1)
  })

  it('clamps per_page to the API window and defaults sort/order handling', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: jsonBody(0, { items: [] }) }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.search({ perPage: 5000 })
    const url = calls[0]?.url ?? ''
    expect(url).toContain('per_page=100')
    expect(url).toContain('page=1')
    await market.search({ perPage: 5, sort: 'stars', order: 'asc' })
    const second = calls[1]?.url ?? ''
    expect(second).toContain('per_page=5')
    expect(second).toContain('sort=stars')
    expect(second).toContain('order=asc')
  })

  it('sends the runtime token as a bearer header and never stores it', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: jsonBody(0, { items: [] }) }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => 'secret-token-abc' })
    await market.search({})
    const headers = calls[0]?.init?.headers ?? {}
    expect(headers.authorization).toBe('Bearer secret-token-abc')
    // Result objects carry no credential material.
    expect(JSON.stringify(await market.search({}))).not.toContain('secret-token-abc')
  })

  it('maps 401 to github/auth', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 401, body: { message: 'Bad credentials' } }))
    await rejectCode(new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({}), 'github/auth')
  })

  it('maps rate-limit exhaustion (403 with remaining 0) to github/rate-limit', async () => {
    const { fetchImpl } = stubGitHub(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
      body: { message: 'API rate limit exceeded' },
    }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await rejectCode(market.search({}), 'github/rate-limit')
  })

  it('maps 429 to github/rate-limit', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 429, headers: { 'retry-after': '30' } }))
    await rejectCode(new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({}), 'github/rate-limit')
  })

  it('maps 404 to github/not-found', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 404 }))
    await rejectCode(new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({}), 'github/not-found')
  })

  it('maps transport failures to github/network', async () => {
    const fetchImpl: FetchLike = async () => { throw new TypeError('fetch failed') }
    await rejectCode(new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({}), 'github/network')
  })

  it('maps an unparsable body to github/bad-response', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 200, rawText: 'not json {' }))
    await rejectCode(new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({}), 'github/bad-response')
  })

  it('keeps stable behavior for a missing items array', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 200, body: { total_count: 5 } }))
    await rejectCode(new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({}), 'github/bad-response')
  })
})

describe('GitHubMarket.repositoryMeta and slug validation', () => {
  it('resolves the default branch from the API', async () => {
    const { fetchImpl } = stubGitHub(() => ({
      status: 200,
      body: { full_name: 'owner/repo', name: 'repo', default_branch: 'release', stargazers_count: 3 },
    }))
    const meta = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).repositoryMeta('owner/repo')
    expect(meta.defaultBranch).toBe('release')
    expect(meta.slug).toBe('owner/repo')
    expect(meta.stars).toBe(3)
  })

  it('falls back to main when the API reports no default branch', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 200, body: { full_name: 'owner/repo' } }))
    const meta = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).repositoryMeta('owner/repo')
    expect(meta.defaultBranch).toBe('main')
  })

  it('rejects a malformed slug with github/bad-request', async () => {
    expect(isValidRepositorySlug('owner')).toBe(false)
    expect(isValidRepositorySlug('own er/repo')).toBe(false)
    expect(isValidRepositorySlug('owner/repo')).toBe(true)
    const { fetchImpl } = stubGitHub(() => ({ status: 200, body: {} }))
    await rejectCode(
      new GitHubMarket({ fetchImpl, tokenProvider: () => null }).repositoryMeta('not-a-slug'),
      'github/bad-request',
    )
  })
})
