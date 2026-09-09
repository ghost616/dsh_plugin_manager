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

/** Build a branch/tag listing body of `count` name-bearing entries. */
function refList(count: number, prefix: string): unknown {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}` }))
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

  it('always sends the -repo exclusion for the harness repository (empty and keyword queries)', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: jsonBody(0, { items: [] }) }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const exclusion = '-repo%3Adeepseek-ai%2Fdeepseek-harness'
    await market.search({}) // browse-all
    expect(calls[0]?.url).toContain('topic%3Adsh-plugin')
    expect(calls[0]?.url).toContain(exclusion)
    await market.search({ keywords: 'agent' })
    expect(calls[1]?.url).toContain('topic%3Adsh-plugin+agent')
    expect(calls[1]?.url).toContain(exclusion)
    expect(calls[1]?.url).not.toContain('%20') // single-token q: encoded spaces are '+'
  })

  it('filters the harness repository out of items even when the server returns it', async () => {
    const { fetchImpl } = stubGitHub(() => ({
      status: 200,
      body: {
        total_count: 2,
        items: [
          { full_name: 'deepseek-ai/deepseek-harness', name: 'deepseek-harness', stargazers_count: 5 },
          { full_name: 'owner/sample-plugin', name: 'sample-plugin', stargazers_count: 42 },
        ],
      },
    }))
    const page = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({ keywords: 'cool' })
    expect(page.items.map((item) => item.repository)).toEqual(['owner/sample-plugin'])
    expect(page.items.some((item) => item.repository === 'deepseek-ai/deepseek-harness')).toBe(false)
    // The server counted the excluded repo; the page-level drop keeps counts consistent.
    expect(page.totalCount).toBe(1)
  })

  it('keeps counts untouched when the server already honored the exclusion', async () => {
    const { fetchImpl } = stubGitHub(() => ({
      status: 200,
      body: { total_count: 1, items: [{ full_name: 'owner/sample-plugin', name: 'sample-plugin' }] },
    }))
    const page = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).search({})
    expect(page.totalCount).toBe(1)
    expect(page.items).toHaveLength(1)
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

describe('GitHubMarket.branches/tags listing', () => {
  const slug = 'owner/sample-plugin'

  it('pages branches at 100 per page and stops after a short page', async () => {
    const { fetchImpl, calls } = stubGitHub((url) => {
      if (url.includes('page=2')) return { status: 200, body: refList(7, 'v2-') }
      return { status: 200, body: refList(100, 'v1-') }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const names = await market.branches(slug)
    expect(names).toHaveLength(107)
    expect(names[0]).toBe('v1-0')
    expect(names[99]).toBe('v1-99')
    expect(names[100]).toBe('v2-0')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url ?? '').toContain(`/repos/${slug}/branches?per_page=100&page=1`)
    expect(calls[1]?.url ?? '').toContain(`/repos/${slug}/branches?per_page=100&page=2`)
  })

  it('caps branches paging at the configured max pages', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: refList(100, 'b-') }))
    const names = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).branches(slug)
    expect(names).toHaveLength(100 * 5)
    expect(calls).toHaveLength(5)
    expect(calls[4]?.url ?? '').toContain('page=5')
  })

  it('lists tags names from the tags endpoint', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: refList(3, 't-') }))
    const names = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).tags(slug)
    expect(names).toEqual(['t-0', 't-1', 't-2'])
    expect(calls[0]?.url ?? '').toContain(`/repos/${slug}/tags?per_page=100&page=1`)
  })

  it('carries only the runtime token in headers, never in the result', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: refList(1, 'b-') }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => 'secret-token-abc' })
    const names = await market.branches(slug)
    const headers = calls[0]?.init?.headers ?? {}
    expect(headers.authorization).toBe('Bearer secret-token-abc')
    expect(JSON.stringify(names)).not.toContain('secret-token-abc')
  })

  it('rejects a non-array listing body as github/bad-response', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 200, body: { items: [] } }))
    await rejectCode(new GitHubMarket({ fetchImpl, tokenProvider: () => null }).branches(slug), 'github/bad-response')
  })

  it('rejects a malformed slug with github/bad-request before any request', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: [] }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await rejectCode(market.branches('not-a-slug'), 'github/bad-request')
    await rejectCode(market.tags('not-a-slug'), 'github/bad-request')
    expect(calls).toHaveLength(0)
  })

  it('maps listing auth/rate-limit/network failures to github codes', async () => {
    const authStub = stubGitHub(() => ({ status: 401 }))
    await rejectCode(new GitHubMarket({ fetchImpl: authStub.fetchImpl, tokenProvider: () => null }).branches(slug), 'github/auth')

    const rateStub = stubGitHub(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
    }))
    await rejectCode(new GitHubMarket({ fetchImpl: rateStub.fetchImpl, tokenProvider: () => null }).tags(slug), 'github/rate-limit')

    const transport: FetchLike = async () => { throw new TypeError('fetch failed') }
    await rejectCode(new GitHubMarket({ fetchImpl: transport, tokenProvider: () => null }).branches(slug), 'github/network')
  })
})

describe('GitHubMarket.readme', () => {
  const slug = 'owner/sample-plugin'

  it('returns the raw Markdown text with the raw accept header', async () => {
    const { fetchImpl, calls } = stubGitHub((_url, init) => {
      expect(init?.headers?.accept).toBe('application/vnd.github.raw')
      return { status: 200, rawText: '# Sample\n\nHello **world**' }
    })
    const text = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).readme(slug)
    expect(text).toBe('# Sample\n\nHello **world**')
    expect(calls[0]?.url).toContain(`/repos/${slug}/readme`)
  })

  it('returns null when the repository has no README (404)', async () => {
    const { fetchImpl } = stubGitHub(() => ({ status: 404, rawText: '404: Not Found' }))
    const text = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).readme(slug)
    expect(text).toBeNull()
  })

  it('does not cache the token on the returned Markdown', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, rawText: 'plain text' }))
    const text = await new GitHubMarket({ fetchImpl, tokenProvider: () => 'secret-token-abc' }).readme(slug)
    expect(text).toBe('plain text')
    const headers = calls[0]?.init?.headers ?? {}
    expect(headers.authorization).toBe('Bearer secret-token-abc')
    expect(text).not.toContain('secret-token-abc')
  })

  it('rejects a malformed slug with github/bad-request before any request', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, rawText: '' }))
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await rejectCode(market.readme('not-a-slug'), 'github/bad-request')
    expect(calls).toHaveLength(0)
  })

  it('maps readme auth/rate-limit/network failures to github codes', async () => {
    const authStub = stubGitHub(() => ({ status: 401 }))
    await rejectCode(new GitHubMarket({ fetchImpl: authStub.fetchImpl, tokenProvider: () => null }).readme(slug), 'github/auth')

    const rateStub = stubGitHub(() => ({ status: 429, headers: { 'retry-after': '30' } }))
    await rejectCode(new GitHubMarket({ fetchImpl: rateStub.fetchImpl, tokenProvider: () => null }).readme(slug), 'github/rate-limit')

    const transport: FetchLike = async () => { throw new TypeError('fetch failed') }
    await rejectCode(new GitHubMarket({ fetchImpl: transport, tokenProvider: () => null }).readme(slug), 'github/network')
  })
})
