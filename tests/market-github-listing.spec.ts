import { describe, expect, it } from 'vitest'
import {
  GITHUB_LIST_MAX_PAGES,
  GITHUB_LIST_PAGE_SIZE,
  GitHubMarket,
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
    calls.push({ url, ...(init === undefined ? {} : { init }) })
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

/** Build a branch/tag listing body of `count` name-bearing entries. */
function refList(count: number, prefix: string): unknown {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}${index}` }))
}

describe('GitHubMarket.tags listing pagination (shared rule with branches)', () => {
  const slug = 'owner/sample-plugin'

  it('stops tags paging early after a short page', async () => {
    const { fetchImpl, calls } = stubGitHub((url) => {
      if (url.includes('page=2')) return { status: 200, body: refList(9, 't2-') }
      return { status: 200, body: refList(100, 't1-') }
    })
    const names = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).tags(slug)
    expect(names).toHaveLength(109)
    expect(names[100]).toBe('t2-0')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url ?? '').toContain(`/repos/${slug}/tags?per_page=${GITHUB_LIST_PAGE_SIZE}&page=1`)
    expect(calls[1]?.url ?? '').toContain(`/repos/${slug}/tags?per_page=${GITHUB_LIST_PAGE_SIZE}&page=2`)
  })

  it('caps tags paging at the configured max pages and never sends a 6th request', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: refList(100, 't-') }))
    const names = await new GitHubMarket({ fetchImpl, tokenProvider: () => null }).tags(slug)
    expect(names).toHaveLength(GITHUB_LIST_PAGE_SIZE * GITHUB_LIST_MAX_PAGES)
    expect(calls).toHaveLength(GITHUB_LIST_MAX_PAGES)
    // Page numbers are sequential and the final page is exactly the cap.
    calls.forEach((call, index) => {
      expect(call.url).toContain(`page=${index + 1}`)
    })
  })

  it('carries the tags token only in request headers, never in the result', async () => {
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: refList(3, 't-') }))
    const names = await new GitHubMarket({ fetchImpl, tokenProvider: () => 'secret-token-abc' }).tags(slug)
    const headers = calls[0]?.init?.headers ?? {}
    expect(headers.authorization).toBe('Bearer secret-token-abc')
    expect(JSON.stringify(names)).not.toContain('secret-token-abc')
  })

  it('resolves the runtime token once per listing call, not once per page', async () => {
    // Full pages force the fetch to hit the page cap, exercising every page
    // of the paging loop while the token source stays single-resolution.
    const { fetchImpl, calls } = stubGitHub(() => ({ status: 200, body: refList(100, 't-') }))
    let resolutions = 0
    const names = await new GitHubMarket({
      fetchImpl,
      tokenProvider: async () => {
        resolutions += 1
        return 'secret-token-abc'
      },
    }).tags(slug)
    expect(names).toHaveLength(GITHUB_LIST_PAGE_SIZE * GITHUB_LIST_MAX_PAGES)
    expect(calls).toHaveLength(GITHUB_LIST_MAX_PAGES)
    expect(resolutions).toBe(1)
    // Every page still authenticates with the same resolved token.
    for (const call of calls) {
      const headers = call.init?.headers ?? {}
      expect(headers.authorization).toBe('Bearer secret-token-abc')
    }
  })
})

describe('githubFetch default accept media type', () => {
  const slug = 'owner/sample-plugin'

  it('keeps application/vnd.github+json as the default accept on non-readme calls', async () => {
    const { fetchImpl, calls } = stubGitHub((_url, init) => {
      expect(init?.headers?.accept).toBe('application/vnd.github+json')
      return { status: 200, body: { full_name: slug, name: 'sample-plugin', default_branch: 'main' } }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    const meta = await market.repositoryMeta(slug)
    expect(meta.slug).toBe(slug)
    expect(calls[0]?.url).toContain(`/repos/${slug}`)
  })

  it('switches the readme call to the raw media type while ordinary calls stay JSON', async () => {
    const accepts: Array<string | undefined> = []
    const { fetchImpl } = stubGitHub((url, init) => {
      accepts.push(init?.headers?.accept)
      if (url.includes('/readme')) return { status: 200, rawText: '# Raw' }
      return { status: 200, body: { full_name: slug, default_branch: 'main' } }
    })
    const market = new GitHubMarket({ fetchImpl, tokenProvider: () => null })
    await market.repositoryMeta(slug)
    await market.readme(slug)
    expect(accepts).toEqual(['application/vnd.github+json', 'application/vnd.github.raw'])
  })
})
