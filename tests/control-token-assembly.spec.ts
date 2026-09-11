/**
 * Production-assembly spec of the credential-backed GitHub token: the REAL
 * `apply()` activation chain (real `Context` + real `Loader` +
 * `MarketRepositoryService` + the compiled control plugin artifact), a real
 * `GitHubMarket` behind the gateway, and a real in-process credential-seam
 * double provided on the same context chain.
 *
 * Why this file exists: the pieces it pins are each invisible to the layer
 * below.
 *
 * - `src/host/control/index.ts` wires the engine's token provider and the
 *   gateway's cache report; a missing wire there is invisible to tsc (the
 *   credential seam is optional by design) and invisible to the fake-engine
 *   specs (they inject their own port). Here the token really travels as a
 *   GitHub request header, so "the engine resolves the seam" is observed
 *   end-to-end.
 * - A committed token write must drop the engine's read-only TTL cache. The
 *   spec proves it the only honest way: a cached search serves ZERO requests,
 *   and after a save the next search goes to the network again.
 * - The launch-environment refusal and the `github/token-unavailable` gate are
 *   observed over the wire shapes the client branches on.
 *
 * Every network hop is a stubbed `globalThis.fetch` (the engine snapshots it at
 * construction), so no test touches GitHub.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { PluginRecordStore } from '../src/host/market/records.ts'
import { MarketRepositoryService } from '../src/host/market/service.ts'
import type { MarketRepository } from '../src/host/market/index.ts'
import { NodeFs } from '../src/host/market/fs.ts'
import {
  GITHUB_TOKEN_FALLBACK_REF,
  GITHUB_TOKEN_REF,
} from '../src/host/market/token.ts'
import type { FetchInit, FetchResponse } from '../src/host/market/github.ts'
import { marketControlPlugin } from '../lib/types/host/control/index.js'

/** Repository slug the stubbed search answers. */
const SLUG = 'octocat/demo-plugin'
/** Reference names as plain strings (the branded refs are strings at runtime). */
const HEAD_REF = GITHUB_TOKEN_REF as unknown as string
const FALLBACK_REF = GITHUB_TOKEN_FALLBACK_REF as unknown as string

/** One recorded network hop of the stubbed GitHub. */
interface Hop {
  readonly url: string
  readonly authorization: string | null
}

/**
 * Stand-in credential seam with the shipped provider's two layers: a read-only
 * `env` table that outranks a writable `store` table (reported as `file`).
 */
class SeamStore {
  readonly env = new Map<string, string>()
  readonly store = new Map<string, string>()
  readonly setCalls: { ref: string; value: string }[] = []
  readonly unsetCalls: string[] = []

  /** Effective value of one reference name. */
  valueOf(ref: string): string | undefined {
    const env = this.env.get(ref)
    if (env !== undefined && env.length > 0) return env
    const stored = this.store.get(ref)
    return stored !== undefined && stored.length > 0 ? stored : undefined
  }

  /**
   * The request-side read the ENGINE performs for every GitHub call (the same
   * precedence `valueOf` models). A seam double without it answers `undefined`
   * and the engine silently goes anonymous, which is exactly the failure this
   * spec would otherwise miss.
   */
  async resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined> {
    const name = ref as unknown as string
    const env = this.env.get(name)
    if (env !== undefined && env.length > 0) return { value: env, source: 'env' }
    const value = this.valueOf(name)
    return value === undefined ? undefined : { value, source: 'file' }
  }

  async describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    const name = ref as unknown as string
    const env = this.env.get(name)
    if (env !== undefined && env.length > 0) return { configured: true, source: 'env', writable: false }
    const stored = this.store.get(name)
    if (stored !== undefined && stored.length > 0) return { configured: true, source: 'file', writable: true }
    return { configured: false, writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.setCalls.push({ ref: ref as unknown as string, value })
    this.store.set(ref as unknown as string, value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.unsetCalls.push(ref as unknown as string)
    this.store.delete(ref as unknown as string)
  }
}

/** The seam shaped for `ctx.provide` (the control layer only drives three methods). */
function seamOf(store: SeamStore): CredentialProvider {
  return store as unknown as CredentialProvider
}

/** Gateway surface as this spec consumes it. */
interface TokenSurface {
  status(): Promise<{ configured: boolean; repositoryPath: string | null }>
  search(
    keywords: string | null,
    perPage: number | null,
    page: number | null,
    options?: { refresh?: boolean },
  ): Promise<{ totalCount: number }>
  repositoryDetail(repository: string, options?: { refresh?: boolean }): Promise<{ name: string }>
  tokenStatus(): Promise<{ configured: boolean; source?: string; writable: boolean; ref: string }>
  saveGitHubToken(value: string | null): Promise<{
    status: { configured: boolean; source?: string; writable: boolean; ref: string }
    cacheCleared: boolean
  }>
  clearGitHubToken(): Promise<{
    status: { configured: boolean; source?: string; writable: boolean; ref: string }
    cacheCleared: boolean
  }>
}

const contexts: Context[] = []
const scratchRoots: string[] = []
const originalFetch = globalThis.fetch

/** Replace the global fetch for one test and count/record every hop. */
function stubGitHub(): { hops: Hop[]; calls: () => number } {
  const hops: Hop[] = []
  const fetchImpl = async (url: string | URL | Request, init?: FetchInit): Promise<FetchResponse> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    const headers = new Map<string, string>()
    const sent = init?.headers
    if (sent !== undefined && !Array.isArray(sent)) {
      for (const [name, value] of Object.entries(sent)) {
        if (typeof value === 'string') headers.set(name.toLowerCase(), value)
      }
    }
    hops.push({ url: href, authorization: headers.get('authorization') ?? null })
    // One stub serves every read endpoint the market uses, each with the shape
    // that endpoint parses: a search page, a branch/tag listing, a raw README
    // body (the README call asks for the raw media type) and repository
    // metadata.
    if (href.includes('/readme')) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => '# demo plugin\n',
      } satisfies FetchResponse
    }
    const body = href.includes('/search/repositories')
      ? { total_count: 1, items: [{ full_name: SLUG, name: 'demo-plugin', stargazers_count: 1 }] }
      : href.includes('/branches')
        ? [{ name: 'main' }]
        : href.includes('/tags')
          ? [{ name: 'v1.0.0' }]
          : { full_name: SLUG, name: 'demo-plugin', default_branch: 'main' }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    } satisfies FetchResponse
  }
  globalThis.fetch = fetchImpl as unknown as typeof globalThis.fetch
  return { hops, calls: () => hops.length }
}

beforeEach(() => {
  // A fresh recorder per test; `afterEach` restores the real fetch.
  stubGitHub()
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  // The scratch tree is removable only after the fibers are down (a Windows
  // unlink of a just-used directory reports ENOTEMPTY); `rmrf` retries briefly.
  for (const root of scratchRoots.splice(0)) await NodeFs.rmrf(root)
  globalThis.fetch = originalFetch
})

/** Boot the real composition with an optional credential seam on its chain. */
async function activate(store: SeamStore | null): Promise<{ ctx: Context; surface: TokenSurface }> {
  const repoRoot = join('tests', '.tmp', `token-assembly-${randomUUID()}`)
  mkdirSync(repoRoot, { recursive: true })
  scratchRoots.push(repoRoot)
  const records = new PluginRecordStore(join(repoRoot, 'plugins.json'))
  await records.load()
  const repository: MarketRepository = {
    root: repoRoot,
    records,
    harnessLinks: { scopePath: join(repoRoot, 'node_modules', '@deepseek-ai'), links: [] },
    harnessVerified: null,
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  if (store !== null) ctx.provide('credentials', seamOf(store))
  new MarketRepositoryService(ctx, repository)
  await ctx.plugin(marketControlPlugin)
  return { ctx, surface: ctx.get('marketControl') as unknown as TokenSurface }
}

describe('market control production assembly: credential-backed GitHub token', () => {
  it('resolves the credential seam per request and reports it through the surface', async () => {
    const seam = new SeamStore()
    seam.store.set(HEAD_REF, 'ghp_assembly')
    const { hops, calls } = stubGitHub()
    const { surface } = await activate(seam)

    await expect(surface.status()).resolves.toMatchObject({ configured: true })
    await expect(surface.tokenStatus()).resolves.toEqual({
      configured: true,
      source: 'file',
      writable: true,
      ref: HEAD_REF,
    })

    await surface.search('demo', null, null)
    expect(hops.at(-1)?.authorization).toBe('Bearer ghp_assembly')

    // A store change between two requests reaches the NEXT request: nothing
    // memoizes the token value (the engine re-resolves, the surface re-reads).
    seam.store.set(HEAD_REF, 'ghp_rotated')
    await surface.search('demo', null, null, { refresh: true })
    expect(hops.at(-1)?.authorization).toBe('Bearer ghp_rotated')
    expect(calls()).toBe(2)
  })

  it('sends no Authorization header while the deployment is anonymous', async () => {
    // Seam mounted, nothing configured: the engine stays anonymous without
    // failing the read.
    const seam = new SeamStore()
    const { hops } = stubGitHub()
    const { surface } = await activate(seam)
    await expect(surface.tokenStatus()).resolves.toEqual({
      configured: false,
      writable: true,
      ref: HEAD_REF,
    })
    await surface.search('demo', null, null)
    expect(hops.at(-1)?.authorization).toBeNull()
  })

  it('drops the read-only cache on every committed token write', async () => {
    const seam = new SeamStore()
    const { hops, calls } = stubGitHub()
    const { surface } = await activate(seam)

    const saved = await surface.saveGitHubToken('ghp_fresh')
    expect(saved.status).toEqual({ configured: true, source: 'file', writable: true, ref: HEAD_REF })
    // Nothing had been memoized yet, so there was nothing to drop.
    expect(saved.cacheCleared).toBe(false)
    expect(seam.setCalls).toEqual([{ ref: HEAD_REF, value: 'ghp_fresh' }])

    await surface.search('demo', null, null)
    expect(hops.at(-1)?.authorization).toBe('Bearer ghp_fresh')
    expect(calls()).toBe(1)

    // Cached within the TTL: the same query serves zero network hops.
    await surface.search('demo', null, null)
    expect(calls()).toBe(1)

    // A refresh bypasses the cache without touching it being necessary.
    await surface.search('demo', null, null, { refresh: true })
    expect(calls()).toBe(2)

    // Re-seed the cache, then clear: the removal must drop what the cached
    // answer was authorized by, so the next read goes out again.
    await surface.search('demo', null, null)
    expect(calls()).toBe(2)
    const cleared = await surface.clearGitHubToken()
    expect(cleared.status).toEqual({ configured: false, writable: true, ref: HEAD_REF })
    expect(cleared.cacheCleared).toBe(true)
    expect(seam.unsetCalls).toEqual([HEAD_REF])

    await surface.search('demo', null, null)
    expect(calls()).toBe(3)
    expect(hops.at(-1)?.authorization).toBeNull()
  })

  it('drops the cached repository detail on a token write as well', async () => {
    const seam = new SeamStore()
    const { hops, calls } = stubGitHub()
    const { surface } = await activate(seam)

    await surface.repositoryDetail(SLUG)
    expect(calls()).toBe(4)
    // Four cached queries: the second call is served from memory.
    await surface.repositoryDetail(SLUG)
    expect(calls()).toBe(4)

    // The explicit refresh reaches every query of the aggregation.
    await surface.repositoryDetail(SLUG, { refresh: true })
    expect(calls()).toBe(8)

    // A committed write drops the whole cache: the next detail call is live.
    await surface.saveGitHubToken('ghp_after_detail')
    await surface.repositoryDetail(SLUG)
    expect(calls()).toBe(12)
    expect(hops.at(-1)?.authorization).toBe('Bearer ghp_after_detail')
  })

  it('refuses a save and a clear while the launch environment supplies the token', async () => {
    const seam = new SeamStore()
    seam.env.set(HEAD_REF, 'env-token')
    const { surface } = await activate(seam)

    await expect(surface.tokenStatus()).resolves.toEqual({
      configured: true,
      source: 'env',
      writable: false,
      ref: HEAD_REF,
    })

    const save = await surface.saveGitHubToken('ignored').catch((error: unknown) => error)
    expect(save).toMatchObject({ code: 'github/token-unavailable' })
    expect((save as Error).message).toContain('launch environment')
    const clear = await surface.clearGitHubToken().catch((error: unknown) => error)
    expect(clear).toMatchObject({ code: 'github/token-unavailable' })

    // Nothing was written anywhere: no shadowing copy was created either.
    expect(seam.setCalls).toEqual([])
    expect(seam.unsetCalls).toEqual([])
    expect(seam.store.has(HEAD_REF)).toBe(false)
    expect(seam.store.has(FALLBACK_REF)).toBe(false)
  })

  it('answers github/token-unavailable while the rest of the surface keeps working', async () => {
    // No credential seam at all: the token surface fails with its one stable
    // code and search still works (anonymously).
    const { hops } = stubGitHub()
    const { surface } = await activate(null)

    const status = await surface.tokenStatus().catch((error: unknown) => error)
    expect(status).toMatchObject({ code: 'github/token-unavailable', details: {} })
    const save = await surface.saveGitHubToken('ghp_any').catch((error: unknown) => error)
    expect(save).toMatchObject({ code: 'github/token-unavailable' })
    const clear = await surface.clearGitHubToken().catch((error: unknown) => error)
    expect(clear).toMatchObject({ code: 'github/token-unavailable' })

    await expect(surface.search('demo', null, null)).resolves.toMatchObject({ totalCount: 1 })
    expect(hops.at(-1)?.authorization).toBeNull()
  })

  it('reports a write through the fallback reference when only it is configured', async () => {
    const seam = new SeamStore()
    seam.store.set(FALLBACK_REF, 'stored-fallback')
    const { surface } = await activate(seam)

    await expect(surface.tokenStatus()).resolves.toEqual({
      configured: true,
      source: 'file',
      writable: true,
      ref: FALLBACK_REF,
    })
    // A clear removes the EFFECTIVE reference (the one the market resolves),
    // and the report afterwards names the head again — the reference a save
    // would target, since nothing supplies a value any more.
    const cleared = await surface.clearGitHubToken()
    expect(cleared.status).toEqual({ configured: false, writable: true, ref: HEAD_REF })
    expect(seam.unsetCalls).toEqual([FALLBACK_REF])
  })
})