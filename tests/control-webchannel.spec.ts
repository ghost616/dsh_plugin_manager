/**
 * Web channel spec (M1 source ops) against the tsc-emitted gateway artifact
 * (see control-gateway.spec.ts header for why decorator sources run compiled).
 * Covers the original record-control methods plus the extended
 * search / previewInstall / install surface and its failure branches.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { MarketError } from '../src/host/market/errors.ts'
// @ts-expect-error -- compiled artifact
import { MARKET_WEB_ROUTE_PATH, registerMarketWebChannel } from '../lib/types/host/control/web-channel.js'
// @ts-expect-error -- compiled artifact
import { MarketControllerGateway } from '../lib/types/host/control/gateway.js'
import { FakeEngines, fakeAnalysisEngine, fakeDistribution, makeSourceOps, testbed } from './support/control-testbed.ts'

const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

/** Minimal exact-route http server shaped like the dsh WebServer contract. */
class RouterServer {
  readonly server = createServer((req, res) => this.dispatch(req, res))
  private readonly exact = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()

  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void {
    if (route.kind !== 'exact' || this.exact.has(route.path)) throw new Error('duplicate route')
    this.exact.set(route.path, route.handler)
    return () => { this.exact.delete(route.path) }
  }

  get url(): string {
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
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

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
}

type WireResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

async function post(router: RouterServer, body: unknown, expectStatus = 200): Promise<{ status: number; body: WireResult }> {
  const response = await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(expectStatus)
  return { status: response.status, body: await response.json() as WireResult }
}

async function call(router: RouterServer, method: string, args: object): Promise<WireResult> {
  return (await post(router, { method, args })).body
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
  const gateway = new MarketControllerGateway(ctx, {
    controller: () => controller,
    repository: () => repository,
    source,
  })
  const router = new RouterServer()
  servers.push(router.server)
  const dispose = registerMarketWebChannel(router, gateway)
  return { router, bed, engines, dispose: () => { dispose() } }
}

describe('market control web channel (M1 source ops round trip)', () => {
  it('serves the activation status over HTTP', async () => {
    const { router, dispose } = routeFor()
    await listen(router.server)
    const active = await call(router, 'status', {})
    expect(active).toMatchObject({ ok: true, value: { configured: true, repositoryPath: '/repo' } })
    dispose()

    const idleRouter = routeFor({ idle: true }).router
    await listen(idleRouter.server)
    const idle = await call(idleRouter, 'status', {})
    expect(idle).toMatchObject({ ok: true, value: { configured: false, repositoryPath: null } })
  })

  it('serves listManaged / setEnabled / double-confirmed remove over HTTP', async () => {
    const { router, bed, dispose } = routeFor()
    await listen(router.server)
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
    await listen(router.server)
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
    const unreviewed = await call(router, 'install', { repository: 'other/repo', confirmToken: 'nope' })
    expect(unreviewed.ok).toBe(false)
    if (!unreviewed.ok) expect(unreviewed.error.code).toBe('market/confirm-required')

    const wrong = await call(router, 'install', { repository: 'octocat/demo-plugin', confirmToken: 'nope' })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error.code).toBe('market/confirm-invalid')

    const installed = await call(router, 'install', {
      repository: 'octocat/demo-plugin',
      confirmToken: reviewValue.confirmToken,
    })
    expect(installed.ok).toBe(true)
    const outcome = (installed as { ok: true; value: { key: string; overwritten: boolean; record: { enabled: boolean } } }).value
    expect(outcome.key).toBe('gh-octocat-demo-plugin')
    expect(outcome.overwritten).toBe(false)
    expect(outcome.record.enabled).toBe(false)
    expect(engines.installCalls).toHaveLength(1)
    expect(engines.installCalls[0]?.version).toBeNull()

    const retry = await call(router, 'install', {
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
    await listen(router.server)

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

    const branchInstalled = await call(router, 'install', {
      repository: 'octocat/demo-plugin', confirmToken: branchValue.confirmToken, refKind: 'branch', version: 'v1.2.3',
    })
    expect(branchInstalled.ok).toBe(true)
    const tagInstalled = await call(router, 'install', {
      repository: 'octocat/demo-plugin', confirmToken: tagValue.confirmToken, refKind: 'tag', version: 'v1.2.3',
    })
    expect(tagInstalled.ok).toBe(true)
    const tagOutcome = (tagInstalled as { ok: true; value: { key: string; record: { source?: { refKind?: string } } } }).value
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
    await listen(router.server)
    for (const method of ['previewInstall', 'install']) {
      const refused = await post(router, {
        method,
        args: {
          repository: 'octocat/demo-plugin',
          ...(method === 'install' ? { confirmToken: 'tok' } : {}),
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
    await listen(router.server)

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
    await listen(router.server)

    const idleSearch = await call(router, 'search', { keywords: 'demo' })
    expect(idleSearch.ok).toBe(false)
    if (!idleSearch.ok) expect(idleSearch.error.code).toBe('market/idle')

    const idleInstall = await call(router, 'install', {
      repository: 'octocat/demo-plugin',
      confirmToken: 'x',
    })
    expect(idleInstall.ok).toBe(false)
    if (!idleInstall.ok) expect(idleInstall.error.code).toBe('market/idle')

    const idleDetail = await call(router, 'repositoryDetail', { repository: 'octocat/demo-plugin' })
    expect(idleDetail.ok).toBe(false)
    if (!idleDetail.ok) expect(idleDetail.error.code).toBe('market/idle')

    const missing = await post(router, { method: 'previewInstall', args: {} }, 400)
    expect(missing.body.ok).toBe(false)
    if (!missing.body.ok) expect(missing.body.error.code).toBe('market/bad-request')

    const missingDetail = await post(router, { method: 'repositoryDetail', args: {} }, 400)
    expect(missingDetail.body.ok).toBe(false)
    if (!missingDetail.body.ok) expect(missingDetail.body.error.code).toBe('market/bad-request')

    const get = await fetch(`${router.url}${MARKET_WEB_ROUTE_PATH}`, { method: 'GET' })
    expect(get.status).toBe(405)
    expect((await get.json() as WireResult).ok).toBe(false)

    const unknown = await post(router, { method: 'deleteEverything', args: {} }, 400)
    expect(unknown.body.ok).toBe(false)

    const malformed = await post(router, 'not json', 400)
    expect(malformed.body.ok).toBe(false)
    dispose()
  })

  it('serves the smart-install classification over HTTP and still installs the checkout', async () => {
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
    engines.installedEntry = null
    await listen(router.server)

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

    const installed = await call(router, 'install', {
      repository: 'octocat/demo-plugin',
      confirmToken: reviewValue.confirmToken,
    })
    expect(installed.ok).toBe(true)
    const outcome = (installed as {
      ok: true
      value: { classification?: string; entry?: string | null; record: { classification?: string; entry: string | null } }
    }).value
    expect(outcome.record).toMatchObject({ classification: 'skills', entry: null })
    // The install-time facts are surfaced back on the outcome as well.
    expect(outcome).toMatchObject({ classification: 'skills', entry: null })
    expect(engines.installCalls[0]).toMatchObject({ classification: 'skills' })
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
    await listen(router.server)

    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    const token = (review as { ok: true; value: { confirmToken: string; classification: string } }).value
    expect(token.classification).toBe('skills')

    const installed = await call(router, 'install', {
      repository: 'octocat/demo-plugin',
      confirmToken: token.confirmToken,
    })
    expect(installed.ok).toBe(true)
    const outcome = (installed as {
      ok: true
      value: { classification?: string; entry?: string | null; record: { classification?: string; entry: string | null } }
    }).value
    // The checkout carries a runnable entry, so it is loadable regardless of
    // the preview prediction.
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
    await listen(router.server)
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
    await listen(router.server)
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
    await listen(router.server)
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

  it('passes an install/entry-missing failure through over HTTP', async () => {
    const { router, engines, dispose } = routeFor()
    await listen(router.server)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const token = (review as { ok: true; value: { confirmToken: string } }).value.confirmToken
    engines.installError = new MarketError(
      'install/entry-missing',
      'The resolved plugin entry "dist/index.js" does not exist inside the checkout.',
    )
    const failed = await call(router, 'install', {
      repository: 'octocat/demo-plugin',
      confirmToken: token,
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.error.code).toBe('install/entry-missing')
      expect(failed.error.message).toContain('dist/index.js')
    }
    dispose()
  })

  it('serves standard (ready) previews without analysis over HTTP', async () => {
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'other', reason: 'never' }),
    })
    const { router, dispose } = routeFor({ analysis })
    await listen(router.server)
    const review = await call(router, 'previewInstall', { repository: 'octocat/demo-plugin' })
    expect(review.ok).toBe(true)
    const value = (review as { ok: true; value: { classification: string; analysis?: unknown } }).value
    expect(value.classification).toBe('plugin')
    expect(value.analysis).toBeUndefined()
    expect(analysis.calls).toHaveLength(0)
    dispose()
  })
})