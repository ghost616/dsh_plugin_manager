/**
 * Web channel spec (M1 source ops) against the tsc-emitted gateway artifact
 * (see control-gateway.spec.ts header for why decorator sources run compiled).
 * Covers the record-control methods plus the phased download channel
 * (prepareDownload → classifyDownload → commitDownload, cancelDownload,
 * setClassification) and its failure branches.
 *
 * HTTP robustness (this spec used to flake as "fetch failed / bad port" when
 * several specs bound sockets in parallel):
 * - every case serves on an EPHEMERAL port (`listen 0` → read the assigned
 *   port) and `serve()` waits until the listener really accepts connections
 *   (`OPTIONS` probe, 3 s bound) before any assertion runs;
 * - TEARDOWN actually used: `closeServer()` = destroy the tracked live sockets
 *   (`RouterServer.destroySockets()`, so a keep-alive connection can never make
 *   `close()` hang) → `server.closeIdleConnections()` → wait for `close` with a
 *   2 s bound. Nothing else terminates the listeners.
 * - REQUEST retries are method-aware and observable: `GET`/`OPTIONS` (the
 *   readiness probe and the raw 405 probe) may repeat freely, while a `POST`
 *   (state-mutating: download/remove/enable) is repeated ONLY when the
 *   transport proves the request never reached a listener
 *   (`ECONNREFUSED`/`ENOTFOUND`); every repeat logs one
 *   `[control-webchannel] retry …` line, so a genuine defect surfaces as a
 *   failure instead of being masked by silent retries.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { MarketError } from '../src/host/market/errors.ts'
import { MARKET_WEB_ROUTE_PATH, registerMarketWebChannel } from '../lib/types/host/control/web-channel.js'
import { MarketControllerGateway } from '../lib/types/host/control/gateway.js'
import { FakeEngines, fakeAnalysisEngine, fakeDistribution, makeSourceOps, testbed } from './support/control-testbed.ts'

/** Bound of one `serve()` readiness wait (ms). */
const SERVE_READY_TIMEOUT_MS = 3_000
/** Attempts of one request (initial try + retries) on a transient failure. */
const REQUEST_ATTEMPTS = 4
/** Idempotent methods: repeating them can never duplicate a state change. */
const IDEMPOTENT_METHODS: readonly string[] = ['GET', 'OPTIONS', 'HEAD']
/**
 * Transport codes a NON-idempotent request may be repeated on. Both mean no
 * listener ever accepted the request, so no handler ran and no state changed.
 */
const NOT_SERVED_CODES: readonly string[] = ['ECONNREFUSED', 'ENOTFOUND']
/** Transport codes an idempotent request may be repeated on (socket churn). */
const TRANSIENT_CODES: readonly string[] = [...NOT_SERVED_CODES, 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']

const contexts: Context[] = []
const servers: RouterServer[] = []
/** Every router this spec started (teardown validation reads them back). */
const servedRouters: RouterServer[] = []
/** Routers `closeServer()` really ran on (set semantics: one entry per router). */
const closedRouters = new Set<RouterServer>()
/** Sockets the teardown cut; reported for the logs, never asserted (env-sensitive). */
let destroyedSocketCount = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(router => closeServer(router)))
})

afterAll(() => {
  // Teardown validation with invariants that do NOT depend on how many
  // keep-alive sockets the environment happened to leave behind (that count is
  // timing/platform sensitive): every router this spec served was handed to the
  // teardown exactly once, the teardown closed none of them twice, and no
  // listener of theirs is still bound when the file ends.
  expect(servedRouters.length).toBeGreaterThan(0)
  expect([...closedRouters]).toHaveLength(servedRouters.length)
  expect(servedRouters.every(router => closedRouters.has(router))).toBe(true)
  expect(servedRouters.every(router => !router.server.listening)).toBe(true)
  console.log(
    `[control-webchannel] teardown: ${servedRouters.length} router(s) closed, ${destroyedSocketCount} socket(s) destroyed`,
  )
})

/**
 * Close one test server without ever hanging the suite: destroy the tracked
 * live sockets (a keep-alive connection would otherwise hold `close()` open),
 * drop the idle ones as well, then wait for `close` with a short bound.
 */
function closeServer(router: RouterServer): Promise<void> {
  const { server } = router
  closedRouters.add(router)
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      router.destroySockets()
      resolve()
      return
    }
    const timer = setTimeout(() => {
      router.destroySockets()
      resolve()
    }, 2_000)
    timer.unref?.()
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
    server.closeIdleConnections()
    router.destroySockets()
  })
}

/** Minimal exact-route http server shaped like the dsh WebServer contract. */
class RouterServer {
  readonly server = createServer((req, res) => this.dispatch(req, res))
  private readonly exact = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  /** Origin of the running listener; set by {@link serve} once it is ready. */
  private origin: string | null = null
  /** Live sockets; teardown destroys them so `close()` can never hang. */
  private readonly sockets = new Set<Socket>()

  constructor() {
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.on('close', () => { this.sockets.delete(socket) })
    })
  }

  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void {
    if (route.kind !== 'exact' || this.exact.has(route.path)) throw new Error('duplicate route')
    this.exact.set(route.path, route.handler)
    return () => { this.exact.delete(route.path) }
  }

  /** Base URL of the listening server; throws while it is not ready. */
  get url(): string {
    if (this.origin === null) {
      throw new Error('the test server is not listening yet — call serve(router) first')
    }
    return this.origin
  }

  /** Record the assigned port once the listener is up. */
  markReady(): void {
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('the test server has no bound TCP address')
    }
    this.origin = `http://127.0.0.1:${address.port}`
  }

  /**
   * Destroy every tracked live socket (teardown step, see `closeServer`):
   * keep-alive connections left by a previous request must not make `close()`
   * wait for their idle timeout.
   */
  destroySockets(): void {
    if (this.sockets.size > 0) destroyedSocketCount += this.sockets.size
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
  }

  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const handler = this.exact.get(pathname)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.writeHead(500)
      res.end(String(error))
    })
  }
}

/**
 * Listen on an ephemeral port (0) and resolve only once the server really
 * accepts connections. A bound listener is not instantly connectable on every
 * platform, so the readiness step is a real request rather than a callback.
 */
async function serve(router: RouterServer): Promise<void> {
  servers.push(router)
  servedRouters.push(router)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    router.server.once('error', onError)
    router.server.listen(0, '127.0.0.1', () => {
      router.server.off('error', onError)
      resolve()
    })
  })
  router.markReady()
  const deadline = Date.now() + SERVE_READY_TIMEOUT_MS
  for (;;) {
    try {
      await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, { method: 'OPTIONS' })
      return
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`the ephemeral test server did not become ready in time: ${String(error)}`)
      }
      await delay(20)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Transport code of a thrown fetch error (the `cause.code` Node attaches). */
function transportCodeOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } } | null)?.cause
  return typeof cause?.code === 'string' ? cause.code : undefined
}

/**
 * Whether one attempt may be repeated. A state-mutating request (POST) is only
 * repeated when the transport proves nothing was served — the connection was
 * refused or the host was unknown — because a repeated POST could otherwise
 * duplicate a side effect and hide a real defect; idempotent methods may also
 * absorb socket churn.
 */
function mayRepeat(method: string, error: unknown): boolean {
  const code = transportCodeOf(error)
  if (code === undefined) return false
  const allowed = IDEMPOTENT_METHODS.includes(method.toUpperCase()) ? TRANSIENT_CODES : NOT_SERVED_CODES
  return allowed.includes(code)
}

type WireResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

/**
 * One HTTP round trip with a bounded, method-aware retry (see `mayRepeat`).
 * Every actual repeat logs one line with the method, the attempt number and the
 * transport code, so a retry can never silently mask a defect while debugging.
 */
async function request(
  router: RouterServer,
  init: { method: string; body?: unknown },
): Promise<{ status: number; text: string }> {
  const method = init.method.toUpperCase()
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      const response = await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      return { status: response.status, text: await response.text() }
    } catch (error) {
      // Not repeatable, or out of attempts: surface the real failure as-is.
      if (!mayRepeat(method, error) || attempt >= REQUEST_ATTEMPTS) throw error
      console.warn(
        `[control-webchannel] retry ${method} ${MARKET_WEB_ROUTE_PATH} — attempt ${attempt + 1}/${REQUEST_ATTEMPTS} after ${transportCodeOf(error) ?? 'unknown transport error'}`,
      )
      await delay(25 * attempt)
    }
  }
}

async function post(router: RouterServer, body: unknown, expectStatus = 200): Promise<{ status: number; body: WireResult }> {
  const response = await request(router, { method: 'POST', body })
  expect(response.status).toBe(expectStatus)
  return { status: response.status, body: JSON.parse(response.text) as WireResult }
}

async function call(router: RouterServer, method: string, args: object): Promise<WireResult> {
  return (await post(router, { method, args })).body
}

/**
 * Walk the three download phases over the wire: prepare (with the review's
 * confirmation), classify, then commit under the label the classification phase
 * proposed (or the caller's override).
 */
async function download(
  router: RouterServer,
  repository: string,
  confirmToken: string,
  refKind: string | null = null,
  version: string | null = null,
  commitAs?: string,
): Promise<WireResult> {
  const args: Record<string, unknown> = { repository, confirmToken }
  if (refKind !== null) args.refKind = refKind
  if (version !== null) args.version = version
  const prepared = await call(router, 'prepareDownload', args)
  if (!prepared.ok) return prepared
  const handle = (prepared as { ok: true; value: { token: string } }).value.token
  const classified = await call(router, 'classifyDownload', { token: handle })
  if (!classified.ok) return classified
  const label = commitAs ?? (classified as { ok: true; value: { classification: string } }).value.classification
  return await call(router, 'commitDownload', { token: handle, classification: label })
}

/** One route-wired gateway over fakes (records + source engines). */
function routeFor(options: {
  idle?: boolean
  analysis?: import('../src/host/control/source.ts').InstallAnalysisEngine
  previewResult?: import('../src/types.ts').PluginPreviewOutcome
} = {}): {
  router: RouterServer
  bed: ReturnType<typeof testbed>
  engines: FakeEngines
  dispose(): void
} {
  const ctx = new Context()
  contexts.push(ctx)
  const bed = testbed()
  const controller = options.idle === true ? null : bed.controller()
  const repository = options.idle === true ? null : bed.repository
  const engines = new FakeEngines()
  if (options.previewResult !== undefined) engines.previewResult = options.previewResult
  const source = makeSourceOps(repository, bed.records, engines, {
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
  })
  // Compiled-artifact gateway over `src/`-typed fakes (see control-gateway.spec.ts):
  // its `.d.ts` names a second nominal identity for every class-typed dep, so
  // this single widening — the fakes ARE instances of the same classes — is the
  // one boundary the dual program needs.
  const deps = {
    controller: () => controller,
    repository: () => repository,
    source,
  } as unknown as import('../lib/types/host/control/gateway.js').MarketControllerGatewayDeps
  const gateway = new MarketControllerGateway(ctx, deps)
  const router = new RouterServer()
  const dispose = registerMarketWebChannel(router, gateway)
  return { router, bed, engines, dispose: () => { dispose() } }
}

describe('market control web channel (M1 source ops round trip)', () => {
  it('serves the activation status over HTTP', async () => {
    const { router, dispose } = routeFor()
    await serve(router)
    const active = await call(router, 'status', {})
    expect(active).toMatchObject({ ok: true, value: { configured: true, repositoryPath: '/repo' } })
    dispose()

    const idleRouter = routeFor({ idle: true }).router
    await serve(idleRouter)
    const idle = await call(idleRouter, 'status', {})
    expect(idle).toMatchObject({ ok: true, value: { configured: false, repositoryPath: null } })
  })

  it('serves listManaged / setEnabled / double-confirmed remove over HTTP', async () => {
    const { router, bed, dispose } = routeFor()
    await serve(router)
    const record = bed.records.seed('gh-web', { enabled: false, localDirName: 'web', entry: 'plugin.mjs' })

    const listed = await call(router, 'listManaged', {})
    expect(listed.ok).toBe(true)
    const entries = (listed as { ok: true; value: { entries: unknown[] } }).value.entries
    expect(entries).toHaveLength(1)

    const enabled = await call(router, 'setEnabled', { key: 'gh-web', enabled: true })
    expect(enabled).toMatchObject({ ok: true, value: { enabled: true } })
    expect(bed.loader.view(record.key)).toMatchObject({ disabled: false, phase: 'active' })

    const bareRemove = await call(router, 'confirmRemove', { key: 'gh-web', token: 'x' })
    expect(bareRemove.ok).toBe(false)
    if (!bareRemove.ok) expect(bareRemove.error.code).toBe('market/confirm-required')

    const request = await call(router, 'requestRemove', { key: 'gh-web' })
    expect(request.ok).toBe(true)
    const token = (request as { ok: true; value: { token: string } }).value.token

    const confirmed = await call(router, 'confirmRemove', { key: 'gh-web', token })
    expect(confirmed.ok).toBe(true)
    const outcome = (confirmed as { ok: true; value: { removedEntry: boolean } }).value
    expect(outcome.removedEntry).toBe(true)
    expect(bed.loader.view(record.key)).toBeUndefined()
    expect(await bed.records.get(record.key)).toBeNull()
    dispose()
  })

  it('serves search and preview/install with the double-confirmed token protocol', async () => {
    const { router, engines, dispose } = routeFor()
    await serve(router)
    engines.searchResult = {
      totalCount: 1,
      items: [{
        repository: 'octocat/demo-plugin',
        name: 'demo-plugin',
        description: 'a dsh plugin',
        stars: 12,
        updatedAt: '2026-01-01T00:00:00.000Z',
        url: 'https://github.com/octocat/demo-plugin',
        cloneUrl: 'https://github.com/octocat/demo-plugin.git',
      }],
    }

    // Default page is 1; an explicit 1-based page is forwarded unchanged.
    const searchDefault = await call(router, 'search', { keywords: 'demo' })
    expect(searchDefault).toMatchObject({ ok: true, value: { totalCount: 1 } })

    const search = await call(router, 'search', { keywords: 'demo', perPage: 10, page: 2 })
    expect(search).toMatchObject({ ok: true, value: { totalCount: 1 } })
    expect(engines.searchCalls).toEqual([
      { keywords: 'demo', page: 1 },
      { keywords: 'demo', perPage: 10, page: 2 },
    ])

    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const reviewValue = (review as { ok: true; value: { key: string; preview: { status: string }; overwrite: boolean; confirmToken: string } }).value
    expect(reviewValue.key).toBe('gh-octocat-demo-plugin')
    expect(reviewValue.preview.status).toBe('ready')
    expect(reviewValue.overwrite).toBe(false)

    // An unreviewed repository is refused outright; a wrong token after a
    // review is invalid; the reviewed token runs once and is single-use.
    const unreviewed = await call(router, 'prepareDownload', { repository: 'other/repo', confirmToken: 'nope' })
    expect(unreviewed.ok).toBe(false)
    if (!unreviewed.ok) expect(unreviewed.error.code).toBe('market/confirm-required')

    const wrong = await call(router, 'prepareDownload', { repository: 'octocat/demo-plugin', confirmToken: 'nope' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error.code).toBe('market/confirm-invalid')

    const outcome = await download(router, 'octocat/demo-plugin', reviewValue.confirmToken)
    expect(outcome).toMatchObject({ ok: true, value: { key: 'gh-octocat-demo-plugin', overwritten: false } })
    const committed = (outcome as { ok: true; value: { record: { enabled: boolean; classification?: string } } }).value
    expect(committed.record.enabled).toBe(false)
    expect(engines.installCalls).toHaveLength(1)
    expect(engines.installCalls[0]?.version).toBeNull()

    // The review confirmation is consumed by the prepare phase.
    const retry = await call(router, 'prepareDownload', {
      repository: 'octocat/demo-plugin',
      confirmToken: reviewValue.confirmToken,
    })
    expect(retry.ok).toBe(false)
    if (!retry.ok) expect(retry.error.code).toBe('market/confirm-required')

    // Second review marks the plugin as installed (overwrite update).
    const reviewAgain = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(reviewAgain.ok).toBe(true)
    expect((reviewAgain as { ok: true; value: { overwrite: boolean } }).value.overwrite).toBe(true)
    dispose()
  })

  it('serves v2 refKind preview/install with per-tuple keys over HTTP', async () => {
    const { router, engines, dispose } = routeFor()
    await serve(router)

    // A branch and a tag of the same name preview as two independent plugins.
    const branch = await call(router, 'previewInstall', {
      repository: 'octocat/demo-plugin', refKind: 'branch', version: 'v1.2.3',
    })
    expect(branch.ok).toBe(true)
    const branchValue = (branch as { ok: true; value: { key: string; refKind: string; confirmToken: string } }).value
    expect(branchValue.refKind).toBe('branch')
    const tag = await call(router, 'previewInstall', {
      repository: 'octocat/demo-plugin', refKind: 'tag', version: 'v1.2.3',
    })
    expect(tag.ok).toBe(true)
    const tagValue = (tag as { ok: true; value: { key: string; refKind: string; confirmToken: string } }).value
    expect(tagValue.refKind).toBe('tag')
    expect(branchValue.key).not.toBe(tagValue.key)

    const branchDownloaded = await download(router, 'octocat/demo-plugin', branchValue.confirmToken, 'branch', 'v1.2.3')
    expect(branchDownloaded.ok).toBe(true)
    const tagDownloaded = await download(router, 'octocat/demo-plugin', tagValue.confirmToken, 'tag', 'v1.2.3')
    expect(tagDownloaded.ok).toBe(true)
    const tagOutcome = (tagDownloaded as { ok: true; value: { key: string; record: { source?: { refKind?: string } } } }).value
    expect(tagOutcome.key).toBe(tagValue.key)
    // The ref kind lives on the record source (PluginMarketGithubSource),
    // mirroring how host installs and the source spec model it.
    expect(tagOutcome.record.source?.refKind).toBe('tag')
    expect(engines.installCalls.map(call => call.key)).toEqual([branchValue.key, tagValue.key])
    expect(engines.installCalls.map(call => call.refKind)).toEqual(['branch', 'tag'])

    // The same-name branch installed earlier is not an overwrite target of the
    // tag review: an immediate re-review of the tag tuple now overwrites only
    // its own record.
    const tagAgain = await call(router, 'previewInstall', {
      repository: 'octocat/demo-plugin', refKind: 'tag', version: 'v1.2.3',
    })
    expect(tagAgain.ok).toBe(true)
    expect((tagAgain as { ok: true; value: { overwrite: boolean } }).value.overwrite).toBe(true)

    // A v2 preview without its ref name is a market/bad-request envelope.
    const missingRef = await call(router, 'previewInstall', {
      repository: 'octocat/demo-plugin', refKind: 'tag',
    })
    expect(missingRef.ok).toBe(false)
    if (!missingRef.ok) expect(missingRef.error.code).toBe('market/bad-request')
    dispose()
  })

  it('rejects an invalid refKind value with a 400 transport envelope', async () => {
    const { router, dispose } = routeFor()
    await serve(router)
    for (const method of ['previewInstall', 'prepareDownload']) {
      const refused = await post(router, {
        method,
        args: {
          repository: 'octocat/demo-plugin',
          ...(method === 'prepareDownload' ? { confirmToken: 'tok' } : {}),
          refKind: 'release',
          version: 'v1',
        },
      }, 400)
      expect(refused.body.ok).toBe(false)
      if (!refused.body.ok) expect(refused.body.error.code).toBe('market/bad-request')
    }
    dispose()
  })

  it('serves repositoryDetail over HTTP with README-404 tolerance', async () => {
    const { router, engines, dispose } = routeFor()
    await serve(router)

    const detail = await call(router, 'repositoryDetail', { repository: 'octocat/demo-plugin' })
    expect(detail.ok).toBe(true)
    const value = (detail as { ok: true; value: { repository: string; defaultBranch: string; readme: string | null } }).value
    expect(value).toMatchObject({
      repository: 'octocat/demo-plugin',
      name: 'demo-plugin',
      defaultBranch: 'main',
      readme: '# demo plugin\n',
    })
    expect(engines.detailCalls).toHaveLength(4)

    // A GitHub 404 for the README is tolerated: value.readme becomes null and
    // the rest of the detail still resolves.
    engines.readmeError = new MarketError('github/not-found', 'no README', {
      path: 'https://api.github.com/repos/octocat/demo-plugin/readme',
    })
    const tolerant = await call(router, 'repositoryDetail', { repository: 'octocat/demo-plugin' })
    expect(tolerant.ok).toBe(true)
    expect((tolerant as { ok: true; value: { readme: string | null } }).value.readme).toBeNull()

    // A non-404 detail failure surfaces as an ok:false envelope with the
    // stable github/* code, never a transport error.
    engines.branchesError = new MarketError('github/network', 'offline', { path: 'https://api.github.com' })
    const failed = await call(router, 'repositoryDetail', { repository: 'octocat/demo-plugin' })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.code).toBe('github/network')
    dispose()
  })

  it('surfaces market/idle and bad-argument branches over HTTP', async () => {
    const { router, dispose } = routeFor({ idle: true })
    await serve(router)

    const idleSearch = await call(router, 'search', { keywords: 'demo' })
    expect(idleSearch.ok).toBe(false)
    if (!idleSearch.ok) expect(idleSearch.error.code).toBe('market/idle')

    const idlePrepare = await call(router, 'prepareDownload', {
      repository: 'octocat/demo-plugin',
      confirmToken: 'x',
    })
    expect(idlePrepare.ok).toBe(false)
    if (!idlePrepare.ok) expect(idlePrepare.error.code).toBe('market/idle')

    const idleClassify = await call(router, 'classifyDownload', { token: 'dl-tok-1' })
    expect(idleClassify.ok).toBe(false)
    if (!idleClassify.ok) expect(idleClassify.error.code).toBe('market/idle')

    const idleCommit = await call(router, 'commitDownload', { token: 'dl-tok-1', classification: 'other' })
    expect(idleCommit.ok).toBe(false)
    if (!idleCommit.ok) expect(idleCommit.error.code).toBe('market/idle')

    const idleDetail = await call(router, 'repositoryDetail', { repository: 'octocat/demo-plugin' })
    expect(idleDetail.ok).toBe(false)
    if (!idleDetail.ok) expect(idleDetail.error.code).toBe('market/idle')

    const missing = await post(router, { method: 'previewInstall', args: {} }, 400)
    expect(missing.body.ok).toBe(false)
    if (!missing.body.ok) expect(missing.body.error.code).toBe('market/bad-request')

    const missingDetail = await post(router, { method: 'repositoryDetail', args: {} }, 400)
    expect(missingDetail.body.ok).toBe(false)
    if (!missingDetail.body.ok) expect(missingDetail.body.error.code).toBe('market/bad-request')

    const get = await request(router, { method: 'GET' })
    expect(get.status).toBe(405)
    expect((JSON.parse(get.text) as WireResult).ok).toBe(false)

    const unknown = await post(router, { method: 'deleteEverything', args: {} }, 400)
    expect(unknown.body.ok).toBe(false)

    const malformed = await post(router, 'not json', 400)
    expect(malformed.body.ok).toBe(false)
    dispose()
  })

  it('serves the smart-install classification over HTTP through the phased download', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'skills', reason: 'an agent skills pack' }),
    })
    const { router, engines, dispose } = routeFor({ analysis, previewResult: degradedNoManifest })
    // The staged checkout carries no runnable entry (an agent skills pack).
    engines.installedEntry = null
    await serve(router)

    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const reviewValue = (review as {
      ok: true
      value: {
        classification: string
        entryNote?: string
        note?: { kind: string; text?: string }
        analysis?: unknown
        confirmToken: string
      }
    }).value
    expect(reviewValue.classification).toBe('skills')
    expect(reviewValue.entryNote).toBe('an agent skills pack')
    expect(reviewValue.note).toEqual({ kind: 'classified', text: 'an agent skills pack' })
    expect(reviewValue.analysis).toEqual({ installable: false, kind: 'skills', reason: 'an agent skills pack' })

    // The staged classifier answers skills, which the commit phase files as-is.
    engines.classification = {
      ...engines.classification,
      classification: 'skills',
      entryPresent: false,
      entryHint: null,
    }
    const installed = await download(router, 'octocat/demo-plugin', reviewValue.confirmToken)
    expect(installed.ok).toBe(true)
    const outcome = (installed as {
      ok: true
      value: { classification?: string; entry?: string | null; record: { classification?: string; entry: string | null } }
    }).value
    expect(outcome.record).toMatchObject({ classification: 'skills', entry: null })
    // The download-time facts are surfaced back on the outcome as well.
    expect(outcome).toMatchObject({ classification: 'skills', entry: null, dependenciesInstalled: false })
    expect(engines.classifications).toEqual(['skills'])
    dispose()
  })

  it('files a predicted skills checkout as plugin when its entry really exists (probe wins)', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'skills', reason: 'the model guessed a skills pack' }),
    })
    const { router, engines, dispose } = routeFor({ analysis, previewResult: degradedNoManifest })
    engines.installedEntry = 'index.js'
    await serve(router)

    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    const token = (review as { ok: true; value: { confirmToken: string; classification: string } }).value
    expect(token.classification).toBe('skills')

    // The staged classifier answers plugin (the checkout carries an entry), so
    // the download files a loadable record regardless of the preview prediction.
    engines.classification = {
      ...engines.classification,
      classification: 'plugin',
      outcome: 'classified',
      unclassified: false,
      entryPresent: true,
      entryHint: 'index.js',
    }
    const installed = await download(router, 'octocat/demo-plugin', token.confirmToken)
    expect(installed.ok).toBe(true)
    const outcome = (installed as {
      ok: true
      value: { classification?: string; entry?: string | null; record: { classification?: string; entry: string | null } }
    }).value
    expect(outcome.record).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    expect(outcome).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    dispose()
  })

  it('classifies an unconventional preview without an analysis engine as other over HTTP', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const { router, dispose } = routeFor({ previewResult: degradedNoManifest })
    await serve(router)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const value = (review as {
      ok: true
      value: { classification: string; entryNote?: string; note?: { kind: string } }
    }).value
    expect(value.classification).toBe('other')
    expect(value.note).toEqual({ kind: 'analysis-unavailable' })
    expect(value.entryNote).toBeUndefined()
    dispose()
  })

  it('degrades an analysis failure to the other classification over HTTP', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({
      error: new MarketError('market/llm-bad-output', 'the model returned prose, not JSON'),
    })
    const { router, dispose } = routeFor({ analysis, previewResult: degradedNoManifest })
    await serve(router)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const value = (review as {
      ok: true
      value: { classification: string; entryNote?: string; note?: { kind: string } }
    }).value
    expect(value.classification).toBe('other')
    expect(value.note).toEqual({ kind: 'analysis-unavailable' })
    dispose()
  })

  it('answers market/not-loadable over HTTP when enabling a skills record', async () => {
    const { router, bed, dispose } = routeFor()
    await serve(router)
    const record = bed.records.seed('gh-skills-pack', {
      enabled: false,
      localDirName: 'skills-pack',
      entry: null,
      classification: 'skills',
    })
    const listed = await call(router, 'listManaged', {})
    expect(listed.ok).toBe(true)
    const view = (listed as { ok: true; value: { entries: { key: string; loadable: boolean }[] } }).value.entries[0]
    expect(view).toMatchObject({ key: 'gh-skills-pack', loadable: false })

    const refused = await call(router, 'setEnabled', { key: 'gh-skills-pack', enabled: true })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.code).toBe('market/not-loadable')
      expect(refused.error.details).toMatchObject({ key: 'gh-skills-pack', reason: 'classification' })
    }
    // The record stayed disabled and unloaded; removing it stays allowed.
    expect((await bed.records.get(record.key))?.enabled).toBe(false)
    expect(bed.loader.view(record.key)).toBeUndefined()
    const request = await call(router, 'requestRemove', { key: 'gh-skills-pack' })
    expect(request.ok).toBe(true)
    dispose()
  })

  it('passes a prepare failure through over HTTP (stable install/* code)', async () => {
    const { router, engines, dispose } = routeFor()
    await serve(router)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const token = (review as { ok: true; value: { confirmToken: string } }).value.confirmToken
    engines.installError = new MarketError(
      'install/git-failed',
      'The git clone step failed (offline).',
    )
    const failed = await call(router, 'prepareDownload', {
      repository: 'octocat/demo-plugin',
      confirmToken: token,
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.error.code).toBe('install/git-failed')
      expect(failed.error.message).toContain('clone')
    }
    dispose()
  })

  it('serves the phased download over HTTP and rejects an unknown handle', async () => {
    const { router, engines, dispose } = routeFor()
    await serve(router)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    const token = (review as { ok: true; value: { confirmToken: string } }).value.confirmToken

    const prepared = await call(router, 'prepareDownload', { repository: 'octocat/demo-plugin', confirmToken: token })
    expect(prepared.ok).toBe(true)
    const handle = (prepared as { ok: true; value: { token: string; state: string; localDirName: string } }).value
    expect(handle.state).toBe('prepared')
    expect(handle.token).toMatch(/^dl-/)

    const classification = await call(router, 'classifyDownload', { token: handle.token })
    expect(classification.ok).toBe(true)
    expect((classification as { ok: true; value: { outcome: string; classification: string } }).value)
      .toMatchObject({ outcome: 'classified', classification: 'plugin' })

    const committed = await call(router, 'commitDownload', { token: handle.token, classification: 'plugin' })
    expect(committed.ok).toBe(true)
    expect((committed as { ok: true; value: { dependenciesInstalled: boolean } }).value.dependenciesInstalled).toBe(false)
    // The handle is consumed by the commit.
    const again = await call(router, 'classifyDownload', { token: handle.token })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('record/not-found')

    // A second download can be cancelled instead of committed.
    const second = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    const secondToken = (second as { ok: true; value: { confirmToken: string } }).value.confirmToken
    const secondPrepared = await call(router, 'prepareDownload', { repository: 'octocat/demo-plugin', confirmToken: secondToken })
    const secondHandle = (secondPrepared as { ok: true; value: { token: string } }).value.token
    const cancelled = await call(router, 'cancelDownload', { token: secondHandle })
    expect(cancelled).toMatchObject({ ok: true, value: true })
    const twice = await call(router, 'cancelDownload', { token: secondHandle })
    expect(twice).toMatchObject({ ok: true, value: false })
    dispose()
  })

  it('validates the committed classification over HTTP with market/bad-request', async () => {
    const { router, dispose } = routeFor()
    await serve(router)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    const token = (review as { ok: true; value: { confirmToken: string } }).value.confirmToken
    const prepared = await call(router, 'prepareDownload', { repository: 'octocat/demo-plugin', confirmToken: token })
    const handle = (prepared as { ok: true; value: { token: string } }).value.token

    for (const bad of ['preset', 'PLUGIN', '']) {
      const refused = await call(router, 'commitDownload', { token: handle, classification: bad })
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.error.code).toBe('market/bad-request')
    }
    // The handle survives a refused label and still commits a valid one.
    const committed = await call(router, 'commitDownload', { token: handle, classification: 'other' })
    expect(committed.ok).toBe(true)
    dispose()
  })

  it('corrects a filed classification over HTTP with setClassification', async () => {
    const { router, bed, dispose } = routeFor()
    await serve(router)
    bed.records.seed('gh-skills-pack', { localDirName: 'skills-pack', entry: null, classification: 'other' })

    const promoted = await call(router, 'setClassification', { key: 'gh-skills-pack', classification: 'plugin' })
    expect(promoted.ok).toBe(false)
    if (!promoted.ok) expect(promoted.error.code).toBe('record/invalid')

    const relabelled = await call(router, 'setClassification', { key: 'gh-skills-pack', classification: 'skills' })
    expect(relabelled).toMatchObject({ ok: true, value: { classification: 'skills', entry: null } })

    const bad = await call(router, 'setClassification', { key: 'gh-skills-pack', classification: 'preset' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('market/bad-request')

    const missing = await call(router, 'setClassification', { key: 'gh-nope', classification: 'other' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('record/not-found')
    dispose()
  })

  it('serves standard (ready) previews without analysis over HTTP', async () => {
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'other', reason: 'never' }),
    })
    const { router, dispose } = routeFor({ analysis })
    await serve(router)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const value = (review as { ok: true; value: { classification: string; analysis?: unknown } }).value
    expect(value.classification).toBe('plugin')
    expect(value.analysis).toBeUndefined()
    expect(analysis.calls).toHaveLength(0)
    dispose()
  })
})
