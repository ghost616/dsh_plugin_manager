/**
 * 离朱 independent verification of the round-6 GitHub-token / refresh /
 * wire-details change set.
 *
 * Deliberately does NOT reuse the module's own token double (`FakeTokenPort`):
 * every token case here drives the PRODUCTION port (`buildCredentialTokenPort`
 * from `src/host/control/token.ts`) over a real cordis `Context` with a real
 * `ctx.provide('credentials', ...)` seam, and the channel cases drive the
 * tsc-emitted gateway/web-channel artifacts over real localhost HTTP. That is
 * what keeps "the test double agrees with the spec" from standing in for "the
 * shipped code does".
 *
 * Probes beyond the module's own suite:
 *  - the three read states and the `ref` semantics (effective vs preferred head);
 *  - a save targets the HEAD ref and takes effect immediately even when the
 *    effective ref was the fallback (the shadowing trap);
 *  - blank / null / undefined refusals with a ZERO-side-effect assertion;
 *  - the read-only launch-environment refusal leaving no shadowing store copy;
 *  - refresh passthrough asserted on OWN-KEY absence (an explicit `undefined`
 *    would still satisfy `=== undefined` while changing engine behavior);
 *  - wire-details forwarding for `retryAfterMs` / `resetAt`, plus the
 *    "undecidable => empty details, no invented field" branch;
 *  - the HTTP channel's own argument handling for the token value.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GITHUB_TOKEN_FALLBACK_REF,
  GITHUB_TOKEN_REF,
} from '../src/host/market/token.ts'
import { MarketError } from '../src/host/market/errors.ts'
import { MarketControlError } from '../src/host/control/controller.ts'
import { buildCredentialTokenPort } from '../src/host/control/token.ts'
import type { MarketRepository } from '../src/host/market/index.ts'
import {
  MarketSourceOperations,
  type InstallerPort,
  type MarketSourceDeps,
  type RepositoryDetailPort,
  type SearchEnginePort,
} from '../src/host/control/source.ts'
import { MarketControllerGateway } from '../lib/types/host/control/gateway.js'
import { MARKET_WEB_ROUTE_PATH, registerMarketWebChannel } from '../lib/types/host/control/web-channel.js'

const HEAD = GITHUB_TOKEN_REF as unknown as string
const FALLBACK = GITHUB_TOKEN_FALLBACK_REF as unknown as string

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

/** Two-layer seam double: read-only `env` outranks the writable `store`. */
class Seam {
  readonly env = new Map<string, string>()
  readonly store = new Map<string, string>()
  readonly setCalls: { ref: string; value: string }[] = []
  readonly unsetCalls: string[] = []
  /** When true, every `describe` throws (a failing seam). */
  failDescribe = false
  /** When true, `set`/`unset` throw (a failing write path). */
  failWrite = false

  private name(ref: CredentialRef): string {
    return ref as unknown as string
  }

  valueOf(name: string): string | undefined {
    const env = this.env.get(name)
    if (env !== undefined && env.length > 0) return env
    const stored = this.store.get(name)
    return stored !== undefined && stored.length > 0 ? stored : undefined
  }

  async resolve(ref: CredentialRef): Promise<{ value: string; source: string } | undefined> {
    const name = this.name(ref)
    const value = this.valueOf(name)
    if (value === undefined) return undefined
    return { value, source: this.env.has(name) ? 'env' : 'file' }
  }

  async describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string; writable: boolean }> {
    if (this.failDescribe) throw new Error('seam unavailable')
    const name = this.name(ref)
    const env = this.env.get(name)
    if (env !== undefined && env.length > 0) return { configured: true, source: 'env', writable: false }
    const stored = this.store.get(name)
    if (stored !== undefined && stored.length > 0) return { configured: true, source: 'file', writable: true }
    return { configured: false, writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (this.failWrite) throw new Error('seam is read-only')
    this.setCalls.push({ ref: this.name(ref), value })
    this.store.set(this.name(ref), value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    if (this.failWrite) throw new Error('seam is read-only')
    this.unsetCalls.push(this.name(ref))
    this.store.delete(this.name(ref))
  }
}

/** Real cordis context with (optionally) the credential seam mounted on it. */
function contextWithSeam(seam: Seam | null): Context {
  const ctx = new Context()
  contexts.push(ctx)
  if (seam !== null) ctx.provide('credentials', seam as unknown as CredentialProvider)
  return ctx
}

/** Build the PRODUCTION token port over the seam double. */
function portOver(seam: Seam) {
  return buildCredentialTokenPort(contextWithSeam(seam))
}

/** One recorded search call, with OWN-KEY visibility of `refresh`. */
interface SearchCall {
  readonly args: Record<string, unknown>
  readonly hasRefreshKey: boolean
}

/** One recorded detail call, with OWN-KEY visibility of `refresh`. */
interface DetailCall {
  readonly kind: string
  readonly hasOptions: boolean
  readonly hasRefreshKey: boolean
  readonly refresh: unknown
}

/** Independent recording engines (not the module's `FakeEngines`). */
class Recorder {
  readonly searchCalls: SearchCall[] = []
  readonly detailCalls: DetailCall[] = []
  searchError: unknown = undefined

  readonly searchEngine: SearchEnginePort = {
    search: async (options) => {
      this.searchCalls.push({
        args: options as unknown as Record<string, unknown>,
        hasRefreshKey: Object.hasOwn(options, 'refresh'),
      })
      if (this.searchError !== undefined) throw this.searchError
      return { totalCount: 0, items: [] }
    },
  }

  readonly detailEngine: RepositoryDetailPort = {
    repositoryMeta: async (slug, options) => {
      this.record('meta', options)
      return {
        slug,
        name: 'demo-plugin',
        description: null,
        stars: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        url: `https://github.com/${slug}`,
        cloneUrl: `https://github.com/${slug}.git`,
        defaultBranch: 'main',
      }
    },
    branches: async (_slug, options) => {
      this.record('branches', options)
      return ['main']
    },
    tags: async (_slug, options) => {
      this.record('tags', options)
      return ['v1.0.0']
    },
    readme: async (_slug, options) => {
      this.record('readme', options)
      return '# demo\n'
    },
  }

  private record(kind: string, options: unknown): void {
    this.detailCalls.push({
      kind,
      hasOptions: options !== undefined,
      hasRefreshKey: options !== undefined && Object.hasOwn(options as object, 'refresh'),
      refresh: options === undefined ? undefined : (options as { refresh?: unknown }).refresh,
    })
  }
}

/** Installer stub: never reached by the read/token paths under test. */
const installerStub: InstallerPort = {
  prepare: async () => { throw new Error('installer not used in this spec') },
  classify: async () => { throw new Error('installer not used in this spec') },
  commit: async () => { throw new Error('installer not used in this spec') },
  cancel: async () => false,
}

const emptyRepository = {
  root: '/repo',
  records: {} as unknown as MarketRepository['records'],
  harnessLinks: { scopePath: '/repo/node_modules/@deepseek-ai', links: [] },
  harnessVerified: null,
} as MarketRepository

/** Source operations over a real token port and the recording engines. */
function sourceWith(
  token: ReturnType<typeof buildCredentialTokenPort>,
  recorder: Recorder,
  repository: MarketRepository | null = emptyRepository,
): MarketSourceOperations {
  const deps: MarketSourceDeps = {
    repository: () => repository,
    searchEngine: recorder.searchEngine,
    detailEngine: recorder.detailEngine,
    previewEngine: { preview: async () => { throw new Error('preview not used in this spec') } },
    installer: () => installerStub,
    token,
    protection: { isProtectedKey: () => false, isSelfModule: () => false },
    syncRecord: async () => {},
    logger: { warn: () => {}, error: () => {} },
  }
  return new MarketSourceOperations(deps)
}

/** Gateway over a real source; records every cache-clear report it is asked for. */
function gatewayWith(
  source: MarketSourceOperations,
  repository: MarketRepository | null = emptyRepository,
): { ctx: Context; gateway: MarketControllerGateway; cacheClears: boolean[] } {
  const ctx = new Context()
  contexts.push(ctx)
  const cacheClears: boolean[] = []
  const deps = {
    controller: () => null,
    repository: () => repository,
    source,
    // Models the production `GitHubMarket.clearCache() > 0` reporter: nothing
    // was memoized, so the honest answer is false.
    clearGitHubCache: () => {
      cacheClears.push(false)
      return false
    },
  } as unknown as import('../lib/types/host/control/gateway.js').MarketControllerGatewayDeps
  const gateway = new MarketControllerGateway(ctx, deps)
  return { ctx, gateway, cacheClears }
}
// ---------------------------------------------------------------------------
// A. Token port: three states, ref semantics, refusals, zero side effects
// ---------------------------------------------------------------------------

describe('LIZHU probe A: production token port over a real credential seam', () => {
  it('reports the three states and the effective-vs-head reference rule', async () => {
    const seam = new Seam()
    const port = portOver(seam)

    // Unconfigured: the reported ref is the preferred HEAD a write would target.
    await expect(port.status()).resolves.toMatchObject({
      status: { configured: false, writable: true, ref: HEAD },
      writeRefName: HEAD,
    })

    // Store layer (source=file, writable).
    seam.store.set(HEAD, 'stored-head')
    await expect(port.status()).resolves.toMatchObject({
      status: { configured: true, source: 'file', writable: true, ref: HEAD },
    })

    // Launch environment (source=env, read-only) outranks the store.
    seam.env.set(HEAD, 'env-head')
    await expect(port.status()).resolves.toMatchObject({
      status: { configured: true, source: 'env', writable: false, ref: HEAD },
    })

    // The fallback is only effective while the head is absent, and the status
    // then names the FALLBACK as the effective reference.
    seam.env.delete(HEAD)
    seam.store.delete(HEAD)
    seam.store.set(FALLBACK, 'stored-fallback')
    await expect(port.status()).resolves.toMatchObject({
      status: { configured: true, source: 'file', writable: true, ref: FALLBACK },
    })
  })

  it('refuses a blank / null / undefined value with github/bad-request and zero side effects', async () => {
    const seam = new Seam()
    const port = portOver(seam)
    for (const value of ['', null, undefined]) {
      const failure = await port.save(value).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(MarketControlError)
      expect((failure as MarketControlError).code).toBe('github/bad-request')
      expect((failure as MarketControlError).details).toEqual({})
    }
    expect(seam.setCalls).toEqual([])
    expect(seam.store.size).toBe(0)
  })

  it('writes the HEAD ref on a save even when the effective ref was the fallback', async () => {
    const seam = new Seam()
    seam.store.set(FALLBACK, 'stored-fallback')
    const port = portOver(seam)
    await expect(port.status()).resolves.toMatchObject({ status: { ref: FALLBACK } })

    const saved = await port.save('ghp_new')
    // The write landed on the HEAD: a fallback-only store would otherwise look
    // saved while an environment DSH_GITHUB_TOKEN kept shadowing it.
    expect(seam.setCalls).toEqual([{ ref: HEAD, value: 'ghp_new' }])
    // 'ghp_new' is seven characters, so the mask rule's short-value protection
    // yields the dots alone (the field is new as of the mask round; the rest of
    // the status shape is unchanged).
    expect(saved.status).toEqual({
      configured: true,
      source: 'file',
      writable: true,
      ref: HEAD,
      maskedHint: '••••••••',
    })

    // And it is effective immediately, without a second explicit read.
    await expect(port.status()).resolves.toMatchObject({ status: { configured: true, ref: HEAD } })
    expect(seam.valueOf(HEAD)).toBe('ghp_new')
  })

  it('clears the EFFECTIVE reference (the fallback), not the head', async () => {
    const seam = new Seam()
    seam.store.set(FALLBACK, 'stored-fallback')
    const port = portOver(seam)
    const cleared = await port.clear()
    expect(seam.unsetCalls).toEqual([FALLBACK])
    expect(cleared.status).toEqual({ configured: false, writable: true, ref: HEAD })
    // The head store layer was never touched by the clear.
    expect(seam.store.has(HEAD)).toBe(false)
  })

  it('refuses save and clear while the launch environment is read-only, writing nothing', async () => {
    const seam = new Seam()
    seam.env.set(HEAD, 'env-token')
    const port = portOver(seam)

    const save = await port.save('shadow-me').catch((error: unknown) => error)
    expect((save as MarketControlError).code).toBe('github/token-unavailable')
    expect((save as Error).message).toContain('launch environment')
    const clear = await port.clear().catch((error: unknown) => error)
    expect((clear as MarketControlError).code).toBe('github/token-unavailable')

    // Zero writes: no shadowing store copy was created anywhere.
    expect(seam.setCalls).toEqual([])
    expect(seam.unsetCalls).toEqual([])
    expect([...seam.store.keys()]).toEqual([])
  })

  it('answers github/token-unavailable (empty details) when no seam is mounted', async () => {
    const port = buildCredentialTokenPort(contextWithSeam(null))
    const status = await port.status().catch((error: unknown) => error)
    expect((status as MarketControlError).code).toBe('github/token-unavailable')
    expect((status as MarketControlError).details).toEqual({})
    const save = await port.save('ghp_x').catch((error: unknown) => error)
    expect((save as MarketControlError).code).toBe('github/token-unavailable')
    expect((save as MarketControlError).details).toEqual({})
    const clear = await port.clear().catch((error: unknown) => error)
    expect((clear as MarketControlError).code).toBe('github/token-unavailable')
    expect((clear as MarketControlError).details).toEqual({})
  })

  it('maps a failing seam onto the same stable code on read and on write', async () => {
    const seam = new Seam()
    const port = portOver(seam)
    seam.failDescribe = true
    const read = await port.status().catch((error: unknown) => error)
    expect((read as MarketControlError).code).toBe('github/token-unavailable')
    seam.failDescribe = false
    seam.failWrite = true
    seam.store.set(FALLBACK, 'x')
    const write = await port.save('ghp_y').catch((error: unknown) => error)
    expect((write as MarketControlError).code).toBe('github/token-unavailable')
  })

  it('re-reads the seam on every call (a change between calls is visible)', async () => {
    const seam = new Seam()
    const port = portOver(seam)
    await expect(port.status()).resolves.toMatchObject({ status: { configured: false } })
    seam.store.set(HEAD, 'late-token')
    await expect(port.status()).resolves.toMatchObject({
      status: { configured: true, ref: HEAD, source: 'file' },
    })
    seam.store.delete(HEAD)
    await expect(port.status()).resolves.toMatchObject({ status: { configured: false } })
  })
})
// ---------------------------------------------------------------------------
// B. Gateway: refresh passthrough and wire details
// ---------------------------------------------------------------------------

describe('LIZHU probe B: gateway refresh passthrough and wire details', () => {
  it('omits the refresh key entirely by default and forwards an explicit value', async () => {
    const recorder = new Recorder()
    const { gateway } = gatewayWith(sourceWith(portOver(new Seam()), recorder))

    await gateway.search('demo', null, null)
    await gateway.search('demo', null, null, {})
    await gateway.search('demo', null, null, { refresh: true })
    await gateway.search('demo', null, null, { refresh: false })

    expect(recorder.searchCalls.map(call => call.hasRefreshKey)).toEqual([false, false, true, true])
    expect(recorder.searchCalls[0]?.args).toEqual({ keywords: 'demo', page: 1 })
    expect(recorder.searchCalls[2]?.args).toEqual({ keywords: 'demo', page: 1, refresh: true })
    // An explicit `false` is a caller decision and does travel (it is not the
    // absent-option case); the engine then simply keeps its cached default.
    expect(recorder.searchCalls[3]?.args).toEqual({ keywords: 'demo', page: 1, refresh: false })
  })

  it('omits the refresh key for all four detail queries by default', async () => {
    const recorder = new Recorder()
    const { gateway } = gatewayWith(sourceWith(portOver(new Seam()), recorder))

    await gateway.repositoryDetail('octocat/demo-plugin')
    expect(recorder.detailCalls.map(call => call.kind)).toEqual(['meta', 'branches', 'tags', 'readme'])
    // The engine may receive an empty options object; what matters is that the
    // `refresh` key never travels explicitly (an own `refresh: undefined` would
    // still read as undefined while changing engine behavior).
    expect(recorder.detailCalls.every(call => call.hasRefreshKey === false)).toBe(true)
    expect(recorder.detailCalls.every(call => call.refresh === undefined)).toBe(true)

    recorder.detailCalls.length = 0
    await gateway.repositoryDetail('octocat/demo-plugin', { refresh: true })
    expect(recorder.detailCalls.every(call => call.hasRefreshKey && call.refresh === true)).toBe(true)
  })

  it('forwards retryAfterMs / resetAt and stays empty when the throttle is undecidable', async () => {
    const recorder = new Recorder()
    const { gateway } = gatewayWith(sourceWith(portOver(new Seam()), recorder))

    recorder.searchError = new MarketError('github/rate-limit', 'rate limited', {
      details: { retryAfterMs: 30_000, resetAt: '2026-01-01T00:30:00.000Z' },
    })
    const throttled = await gateway.search('demo', null, null).catch((error: unknown) => error)
    expect((throttled as { code: string }).code).toBe('github/rate-limit')
    expect((throttled as { details: unknown }).details).toEqual({
      retryAfterMs: 30_000,
      resetAt: '2026-01-01T00:30:00.000Z',
    })

    // Undecidable: no wait fact was attached, so details must be empty rather
    // than carry a fabricated 0 / epoch.
    recorder.searchError = new MarketError('github/rate-limit', 'rate limited')
    const bare = await gateway.search('demo', null, null).catch((error: unknown) => error)
    expect((bare as { code: string }).code).toBe('github/rate-limit')
    expect((bare as { details: unknown }).details).toEqual({})

    // A malformed wait is dropped, never coerced.
    recorder.searchError = new MarketError('github/rate-limit', 'rate limited', {
      details: { retryAfterMs: 'soon', resetAt: 7 },
    })
    const malformed = await gateway.search('demo', null, null).catch((error: unknown) => error)
    expect((malformed as { details: unknown }).details).toEqual({})
  })

  it('keeps the pre-existing key / path / reason forwarding unchanged', async () => {
    const recorder = new Recorder()
    const { gateway } = gatewayWith(sourceWith(portOver(new Seam()), recorder))
    recorder.searchError = new MarketError('github/not-found', 'gone', {
      details: { key: 'gh-a-b', path: '/repo/a', reason: 'unknown', extra: 'dropped' },
    })
    const failure = await gateway.search('demo', null, null).catch((error: unknown) => error)
    expect((failure as { details: unknown }).details).toEqual({
      key: 'gh-a-b',
      path: '/repo/a',
      reason: 'unknown',
    })
  })

  it('refuses a null token value on the gateway path with github/bad-request', async () => {
    const seam = new Seam()
    const { gateway, cacheClears } = gatewayWith(sourceWith(portOver(seam), new Recorder()))
    for (const value of [null, undefined]) {
      const failure = await gateway.saveGitHubToken(value as string | null).catch((error: unknown) => error)
      expect((failure as { code: string }).code).toBe('github/bad-request')
    }
    expect(seam.setCalls).toEqual([])
    // A refused save must not report a cache clear either (nothing committed).
    expect(cacheClears).toEqual([])
  })

  it('answers the token surface while idle and keeps repository ops market/idle', async () => {
    const seam = new Seam()
    const source = sourceWith(portOver(seam), new Recorder(), null)
    const { gateway } = gatewayWith(source, null)

    await expect(gateway.tokenStatus()).resolves.toEqual({
      configured: false,
      writable: true,
      ref: HEAD,
    })
    await expect(gateway.saveGitHubToken('ghp_idle')).resolves.toMatchObject({
      status: { configured: true, ref: HEAD },
    })
    await expect(gateway.clearGitHubToken()).resolves.toMatchObject({
      status: { configured: false, ref: HEAD },
    })

    const search = await gateway.search('demo', null, null).catch((error: unknown) => error)
    expect((search as { code: string }).code).toBe('market/idle')
    const detail = await gateway.repositoryDetail('octocat/demo-plugin').catch((error: unknown) => error)
    expect((detail as { code: string }).code).toBe('market/idle')
  })
})
// ---------------------------------------------------------------------------
// C. Web channel: the token value as the CLIENT sends it
// ---------------------------------------------------------------------------

/** Minimal exact-route webserver shim over a real node listener. */
async function serveChannel(gateway: MarketControllerGateway): Promise<string> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = routes.get(path)
    if (handler === undefined) {
      res.writeHead(404)
      res.end('no route')
      return
    }
    void handler(req, res)
  })
  registerMarketWebChannel({
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }, gateway)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port assigned')
  return `http://127.0.0.1:${address.port}${MARKET_WEB_ROUTE_PATH}`
}

/** One HTTP POST with a body that is already a JSON string. */
function post(url: string, body: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** POST one well-formed envelope; returns the parsed response. */
async function callChannel(
  url: string,
  method: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return await post(url, JSON.stringify({ method, args }))
}

/** Narrow the envelope for assertions. */
interface Envelope {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string; details: unknown }
}

function envelope(raw: { status: number; body: unknown }): Envelope {
  return raw.body as Envelope
}

describe('LIZHU probe C: token writes through the real HTTP channel', () => {
  it('round-trips status / save / clear with the production token port', async () => {
    const seam = new Seam()
    const { gateway, cacheClears } = gatewayWith(sourceWith(portOver(seam), new Recorder()))
    const url = await serveChannel(gateway)

    expect(envelope(await callChannel(url, 'tokenStatus', {})).value).toEqual({
      configured: false,
      writable: true,
      ref: HEAD,
    })

    const saved = envelope(await callChannel(url, 'saveGitHubToken', { value: 'ghp_http' }))
    expect(saved.ok).toBe(true)
    expect(saved.value).toEqual({
      // 'ghp_http' is eight characters → short-value protection: dots alone (the
      // maskedHint field is new as of the mask round; the rest is unchanged).
      status: {
        configured: true,
        source: 'file',
        writable: true,
        ref: HEAD,
        maskedHint: '••••••••',
      },
      cacheCleared: false,
    })
    expect(seam.setCalls).toEqual([{ ref: HEAD, value: 'ghp_http' }])

    const cleared = envelope(await callChannel(url, 'clearGitHubToken', {}))
    expect(cleared.ok).toBe(true)
    expect(cleared.value).toEqual({
      status: { configured: false, writable: true, ref: HEAD },
      cacheCleared: false,
    })
    expect(seam.unsetCalls).toEqual([HEAD])
    // Both writes asked for a cache clear; the reporter answered false both
    // times (nothing was memoized), which is the honest report.
    expect(cacheClears).toEqual([false, false])
  })

  it('refuses an empty token over HTTP, writing nothing', async () => {
    const seam = new Seam()
    const { gateway, cacheClears } = gatewayWith(sourceWith(portOver(seam), new Recorder()))
    const url = await serveChannel(gateway)

    const answer = envelope(await callChannel(url, 'saveGitHubToken', { value: '' }))
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('github/bad-request')
    expect(seam.setCalls).toEqual([])
    expect(cacheClears).toEqual([])
  })

  it('DEFECT: refuses a null / non-string token argument on the wire instead of coercing it', async () => {
    const seam = new Seam()
    const { gateway, cacheClears } = gatewayWith(sourceWith(portOver(seam), new Recorder()))
    const url = await serveChannel(gateway)

    // Every one of these carries no usable token value; the wire contract says
    // "not provided" (github/bad-request) and demands ZERO side effects. None
    // may reach the seam as its String() rendering.
    const violations: string[] = []
    for (const value of [null, 123, true, { token: 'ghp_smuggled' }, ['ghp_x']]) {
      seam.setCalls.length = 0
      const raw = await callChannel(url, 'saveGitHubToken', { value })
      const answer = envelope(raw)
      const wrote = seam.setCalls.map(call => call.value)
      if (answer.ok || wrote.length > 0) {
        violations.push(
          `value=${JSON.stringify(value)} -> http ${raw.status} ok=${answer.ok} writes=${JSON.stringify(wrote)}`,
        )
      }
      if (!answer.ok && answer.error?.code !== 'github/bad-request') {
        violations.push(`value=${JSON.stringify(value)} -> refused with ${String(answer.error?.code)}`)
      }
    }
    expect(violations).toEqual([])
    expect(seam.setCalls).toEqual([])
    expect(cacheClears).toEqual([])
  })

  it('rejects a missing value argument at the transport level (400)', async () => {
    const seam = new Seam()
    const { gateway } = gatewayWith(sourceWith(portOver(seam), new Recorder()))
    const url = await serveChannel(gateway)
    const raw = await callChannel(url, 'saveGitHubToken', {})
    expect(raw.status).toBe(400)
    expect(envelope(raw).error?.code).toBe('market/bad-request')
    expect(seam.setCalls).toEqual([])
  })

  it('carries the refresh flag over HTTP and rejects a non-boolean one (400)', async () => {
    const recorder = new Recorder()
    const { gateway } = gatewayWith(sourceWith(portOver(new Seam()), recorder))
    const url = await serveChannel(gateway)

    await callChannel(url, 'search', { keywords: 'demo' })
    await callChannel(url, 'search', { keywords: 'demo', refresh: true })
    expect(recorder.searchCalls.map(call => call.hasRefreshKey)).toEqual([false, true])

    recorder.detailCalls.length = 0
    await callChannel(url, 'repositoryDetail', { repository: 'octocat/demo-plugin' })
    expect(recorder.detailCalls.every(call => call.hasRefreshKey === false)).toBe(true)
    recorder.detailCalls.length = 0
    await callChannel(url, 'repositoryDetail', { repository: 'octocat/demo-plugin', refresh: true })
    expect(recorder.detailCalls.every(call => call.hasRefreshKey && call.refresh === true)).toBe(true)

    for (const bogus of ['yes', 1, {}]) {
      const raw = await callChannel(url, 'search', { keywords: 'demo', refresh: bogus })
      expect(raw.status, `refresh=${JSON.stringify(bogus)}`).toBe(400)
      expect(envelope(raw).error?.code).toBe('market/bad-request')
    }
  })

  it('carries the throttle wait over HTTP and answers 200 with ok:false', async () => {
    const recorder = new Recorder()
    const { gateway } = gatewayWith(sourceWith(portOver(new Seam()), recorder))
    const url = await serveChannel(gateway)

    recorder.searchError = new MarketError('github/rate-limit', 'rate limited', {
      details: { retryAfterMs: 45_000, resetAt: '2026-01-01T00:45:00.000Z' },
    })
    const raw = await callChannel(url, 'search', { keywords: 'demo' })
    expect(raw.status).toBe(200)
    const answer = envelope(raw)
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('github/rate-limit')
    expect(answer.error?.details).toEqual({
      retryAfterMs: 45_000,
      resetAt: '2026-01-01T00:45:00.000Z',
    })

    recorder.searchError = new MarketError('github/rate-limit', 'rate limited')
    const bare = envelope(await callChannel(url, 'search', { keywords: 'demo' }))
    expect(bare.error?.details).toEqual({})
  })

  it('keeps the token surface answerable while the market is idle', async () => {
    const seam = new Seam()
    const source = sourceWith(portOver(seam), new Recorder(), null)
    const { gateway } = gatewayWith(source, null)
    const url = await serveChannel(gateway)

    expect(envelope(await callChannel(url, 'tokenStatus', {})).ok).toBe(true)
    const search = envelope(await callChannel(url, 'search', { keywords: 'demo' }))
    expect(search.ok).toBe(false)
    expect(search.error?.code).toBe('market/idle')
  })
})