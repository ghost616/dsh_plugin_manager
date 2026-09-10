import { describe, expect, it } from 'vitest'
import type { PluginPreviewOutcome } from '../src/types.ts'
import { MarketError } from '../src/host/market/errors.ts'
import { PluginPreviewer } from '../src/host/market/preview.ts'
import type { FetchInit, FetchLike, FetchResponse } from '../src/host/market/github.ts'

/** Route-based GitHub stub covering the API meta call and raw package reads. */
function stubRoutes(
  routes: Record<string, () => { status: number; body?: unknown; rawText?: string }>,
): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url, _init?: FetchInit) => {
    urls.push(url)
    const handler = routes[url]
    if (!handler) throw new TypeError(`fetch failed: unexpected url ${url}`)
    const stub = handler()
    return {
      status: stub.status,
      ok: stub.status >= 200 && stub.status < 300,
      headers: { get: () => null },
      text: async () => stub.rawText ?? JSON.stringify(stub.body ?? {}),
    } satisfies FetchResponse
  }
  return { fetchImpl, urls }
}

const manifest = {
  name: 'sample-plugin',
  version: '1.2.3',
  dependencies: { '@deepseek-ai/cordis': '^4.0.0' },
  peerDependencies: { react: '^18.0.0' },
}

function makePreviewer(routes: Record<string, () => { status: number; body?: unknown; rawText?: string }>) {
  const { fetchImpl, urls } = stubRoutes(routes)
  return { previewer: new PluginPreviewer({ fetchImpl, tokenProvider: () => null }), urls }
}

function rawUrl(slug: string, branch: string): string {
  return `https://raw.githubusercontent.com/${slug}/${branch}/package.json`
}

describe('PluginPreviewer.preview', () => {
  it('summarizes the manifest of the default branch as ready', async () => {
    const slug = 'owner/sample-plugin'
    const { previewer } = makePreviewer({
      [`https://api.github.com/repos/${slug}`]: () => ({ status: 200, body: { full_name: slug, default_branch: 'main' } }),
      [rawUrl(slug, 'main')]: () => ({ status: 200, body: manifest }),
    })
    const outcome = await previewer.preview(slug)
    expect(outcome.status).toBe('ready')
    if (outcome.status === 'ready') {
      expect(outcome.summary.name).toBe('sample-plugin')
      expect(outcome.summary.version).toBe('1.2.3')
      expect(outcome.summary.dependencies.dependencies).toEqual(['@deepseek-ai/cordis'])
      expect(outcome.summary.dependencies.peerDependencies).toEqual(['react'])
    }
  })

  it('probes main/master when the default branch has no package.json', async () => {
    const slug = 'owner/fallback'
    const { previewer, urls } = makePreviewer({
      [`https://api.github.com/repos/${slug}`]: () => ({ status: 200, body: { full_name: slug, default_branch: 'dev' } }),
      [rawUrl(slug, 'dev')]: () => ({ status: 404 }),
      [rawUrl(slug, 'main')]: () => ({ status: 200, body: manifest }),
    })
    const outcome = await previewer.preview(slug)
    expect(outcome.status).toBe('ready')
    expect(urls.some((url) => url.includes('/main/package.json'))).toBe(true)
  })

  it('degrades with a friendly reason when no branch carries package.json', async () => {
    const slug = 'owner/nomanifest'
    const { previewer } = makePreviewer({
      [`https://api.github.com/repos/${slug}`]: () => ({ status: 200, body: { full_name: slug, default_branch: 'main' } }),
      [rawUrl(slug, 'main')]: () => ({ status: 404 }),
      [rawUrl(slug, 'master')]: () => ({ status: 404 }),
    })
    const outcome = await previewer.preview(slug)
    expect(outcome.status).toBe('degraded')
    if (outcome.status === 'degraded') {
      expect(outcome.code).toBe('github/not-found')
      expect(outcome.reason.length).toBeGreaterThan(0)
      expect(outcome.summary.dependencies).toEqual({ dependencies: [], peerDependencies: [] })
    }
  })

  it('degrades (never throws) when the repository metadata is unreadable', async () => {
    const slug = 'owner/private'
    const { previewer } = makePreviewer({
      [`https://api.github.com/repos/${slug}`]: () => ({ status: 404 }),
    })
    const outcome: PluginPreviewOutcome = await previewer.preview(slug)
    expect(outcome.status).toBe('degraded')
    if (outcome.status === 'degraded') expect(outcome.code).toBe('github/not-found')
  })

  it('degrades with github/bad-response on an unparsable manifest', async () => {
    const slug = 'owner/broken'
    const { previewer } = makePreviewer({
      [`https://api.github.com/repos/${slug}`]: () => ({ status: 200, body: { full_name: slug, default_branch: 'main' } }),
      [rawUrl(slug, 'main')]: () => ({ status: 200, rawText: 'not json' }),
    })
    const outcome = await previewer.preview(slug)
    expect(outcome.status).toBe('degraded')
    if (outcome.status === 'degraded') expect(outcome.code).toBe('github/bad-response')
  })

  it('degrades with the rate-limit code when the API is throttled', async () => {
    const slug = 'owner/limited'
    const limited: FetchLike = async () => ({
      status: 403,
      ok: false,
      headers: { get: (name: string) => (name === 'x-ratelimit-remaining' ? '0' : null) },
      text: async () => JSON.stringify({ message: 'API rate limit exceeded' }),
    })
    const outcome = await new PluginPreviewer({ fetchImpl: limited, tokenProvider: () => null }).preview(slug)
    expect(outcome.status).toBe('degraded')
    if (outcome.status === 'degraded') expect(outcome.code).toBe('github/rate-limit')
  })

  it('rejects a malformed slug with github/bad-request', async () => {
    const { fetchImpl } = stubRoutes({})
    const previewerInstance = new PluginPreviewer({ fetchImpl, tokenProvider: () => null })
    try {
      await previewerInstance.preview('bad slug')
      throw new Error('expected github/bad-request')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('github/bad-request')
    }
  })

  it('keeps dependencies sorted and handles missing dependency sections', async () => {
    const slug = 'owner/minimal'
    const { previewer } = makePreviewer({
      [`https://api.github.com/repos/${slug}`]: () => ({ status: 200, body: { full_name: slug, default_branch: 'main' } }),
      [rawUrl(slug, 'main')]: () => ({ status: 200, body: { name: 'minimal' } }),
    })
    const outcome = await previewer.preview(slug)
    expect(outcome.status).toBe('ready')
    if (outcome.status === 'ready') {
      expect(outcome.summary.version).toBeNull()
      expect(outcome.summary.dependencies.dependencies).toEqual([])
    }
  })
})
