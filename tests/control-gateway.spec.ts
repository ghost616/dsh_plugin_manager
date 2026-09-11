/**
 * Gateway host-surface spec. The gateway source uses TC39 standard decorators;
 * the vitest/oxc pipeline of this environment cannot lower them for Node 25,
 * so this spec drives the tsc-emitted artifact (lib/types/host/control/*.js,
 * produced by `tsc -b tsconfig.json` ahead of `pnpm test`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { InstallAnalysisEngine } from '../src/host/control/source.ts'
import {
  MARKET_CONTROL_SERVICE_KEY,
  MarketControllerGateway,
  toRemoteError,
} from '../lib/types/host/control/gateway.js'
import { MarketControlError } from '../lib/types/host/control/controller.js'
import { MarketError } from '../src/host/market/errors.ts'
import {
  DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
  DOWNLOAD_REASON_EXPIRED,
  DOWNLOAD_REASON_REPAIR_RECORD_STALE,
  DOWNLOAD_REASON_UNKNOWN,
} from '../src/host/control/source.ts'
import {
  fakeAnalysisEngine,
  fakeDistribution,
  key,
  makeSourceOps,
  testbed,
} from './support/control-testbed.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * Walk the three download phases through the gateway surface: prepare with the
 * review's confirmation, classify the staged checkout, then commit under the
 * label the classification phase proposed.
 */
async function downloadVia(
  gateway: MarketControllerGateway,
  repository: string,
  confirmToken: string,
  refKind: string | null,
  version: string | null,
): Promise<Awaited<ReturnType<MarketControllerGateway['commitDownload']>>> {
  const prepared = await gateway.prepareDownload(repository, confirmToken, refKind, version)
  const classification = await gateway.classifyDownload(prepared.token)
  return await gateway.commitDownload(prepared.token, classification.classification)
}

function gatewayWith(
  options: {
    idle?: boolean
    analysis?: InstallAnalysisEngine
    previewResult?: import('../src/types.ts').PluginPreviewOutcome
    now?: () => Date
    downloadTtlMs?: number
  } = {},
): {
  ctx: Context
  gateway: MarketControllerGateway
  engines: import('./support/control-testbed.ts').FakeEngines
  records: import('./support/control-testbed.ts').FakeRecords
} {
  const ctx = new Context()
  contexts.push(ctx)
  const bed = testbed()
  if (options.previewResult !== undefined) bed.engines.previewResult = options.previewResult
  const controller = options.idle === true ? null : bed.controller()
  const repository = options.idle === true ? null : bed.repository
  const source = makeSourceOps(repository, bed.records, bed.engines, {
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.downloadTtlMs === undefined ? {} : { downloadTtlMs: options.downloadTtlMs }),
  })
  // This spec imports the tsc-emitted gateway artifact, so its `.d.ts` names a
  // second nominal identity for every class-typed dep (`MarketControllerGateway`
  // itself declares a private `deps` member). The fakes above are REAL
  // instances of those classes — the artifact is a plain emit of the same
  // sources — but the two declarations are separate private-member identities,
  // so the deps object needs one explicit widening here. Everything the fakes
  // and the source layer share is still checked: the controller is built through
  // `testbed().deps()` (`MarketControllerDeps`), `makeSourceOps` through
  // `MarketSourceDeps`, and the assertions below run the real behavior.
  const deps = {
    controller: () => controller,
    repository: () => repository,
    source,
  } as unknown as import('../lib/types/host/control/gateway.js').MarketControllerGatewayDeps
  const gateway = new MarketControllerGateway(ctx, deps)
  return { ctx, gateway, engines: bed.engines, records: bed.records }
}

describe('MarketControllerGateway host Remote surface', () => {
  it('publishes the marketControl namespace with the phased download surface', () => {
    const { gateway } = gatewayWith()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: MARKET_CONTROL_SERVICE_KEY,
      namespace: MARKET_CONTROL_SERVICE_KEY,
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'listManaged', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'requestRemove', invocation: { kind: 'direct' } },
      { method: 'confirmRemove', invocation: { kind: 'direct' } },
      { method: 'search', invocation: { kind: 'direct' } },
      { method: 'repositoryDetail', invocation: { kind: 'direct' } },
      { method: 'previewInstall', invocation: { kind: 'direct' } },
      { method: 'prepareDownload', invocation: { kind: 'direct' } },
      { method: 'classifyDownload', invocation: { kind: 'direct' } },
      { method: 'commitDownload', invocation: { kind: 'direct' } },
      { method: 'cancelDownload', invocation: { kind: 'direct' } },
      { method: 'setClassification', invocation: { kind: 'direct' } },
    ])
  })

  it('registers the gateway under its service key', () => {
    const { ctx, gateway } = gatewayWith()
    // Cordis resolves service reads through a traceable wrapper, so identity
    // is asserted through the binding and surface instead of object equality.
    const resolved = ctx.get(MARKET_CONTROL_SERVICE_KEY) as {
      typertRemote?: { serviceKey?: string; namespace?: string }
      listManaged?: unknown
      search?: unknown
    }
    expect(resolved.typertRemote).toMatchObject({
      serviceKey: MARKET_CONTROL_SERVICE_KEY,
      namespace: MARKET_CONTROL_SERVICE_KEY,
    })
    expect(typeof resolved.listManaged).toBe('function')
    expect(typeof resolved.search).toBe('function')
    expect(gateway).toBeInstanceOf(MarketControllerGateway)
  })

  it('listManaged answers through the live controller', async () => {
    const { gateway } = gatewayWith()
    const result = await gateway.listManaged()
    expect(result.entries).toEqual([])
  })

  it('reports configured status with the repository root', async () => {
    const { gateway } = gatewayWith()
    await expect(gateway.status()).resolves.toEqual({ configured: true, repositoryPath: '/repo' })
  })

  it('reports idle status without throwing while no repository is configured', async () => {
    const { gateway } = gatewayWith({ idle: true })
    await expect(gateway.status()).resolves.toEqual({ configured: false, repositoryPath: null })
  })

  it('answers market/idle for every operation while no repository is configured', async () => {
    const { gateway } = gatewayWith({ idle: true })
    const idle = await gateway.listManaged().catch((error: unknown) => error)
    expect(remoteErrorOf(idle)).toMatchObject({ code: 'market/idle' })
    const idleSearch = await gateway.search('demo', null, null).catch((error: unknown) => error)
    expect(remoteErrorOf(idleSearch)).toMatchObject({ code: 'market/idle' })
    const idlePrepare = await gateway.prepareDownload('octocat/demo', 'tok', null, null).catch((error: unknown) => error)
    expect(remoteErrorOf(idlePrepare)).toMatchObject({ code: 'market/idle' })
    const idleClassify = await gateway.classifyDownload('dl-tok-1').catch((error: unknown) => error)
    expect(remoteErrorOf(idleClassify)).toMatchObject({ code: 'market/idle' })
    const idleCommit = await gateway.commitDownload('dl-tok-1', 'other').catch((error: unknown) => error)
    expect(remoteErrorOf(idleCommit)).toMatchObject({ code: 'market/idle' })
    const idlePreview = await gateway.previewInstall('octocat/demo', 'tag', 'v1').catch((error: unknown) => error)
    expect(remoteErrorOf(idlePreview)).toMatchObject({ code: 'market/idle' })
    const idleDetail = await gateway.repositoryDetail('octocat/demo').catch((error: unknown) => error)
    expect(remoteErrorOf(idleDetail)).toMatchObject({ code: 'market/idle' })
  })

  it('delegates search to the source engine and forwards the 1-based page', async () => {
    const { gateway, engines } = gatewayWith()
    const page = await gateway.search('agents', 5, 2)
    expect(page.totalCount).toBe(0)
    expect(page.items).toEqual([])
    expect(engines.searchCalls).toEqual([{ keywords: 'agents', perPage: 5, page: 2 }])
  })

  it('defaults a null gateway search page to 1', async () => {
    const { gateway, engines } = gatewayWith()
    await gateway.search('agents', null, null)
    expect(engines.searchCalls).toEqual([{ keywords: 'agents', page: 1 }])
  })

  it('delegates repositoryDetail to the source engine and returns the aggregate', async () => {
    const { gateway, engines } = gatewayWith()
    const detail = await gateway.repositoryDetail('octocat/demo-plugin')
    expect(detail).toMatchObject({
      repository: 'octocat/demo-plugin',
      name: 'demo-plugin',
      defaultBranch: 'main',
      branches: ['main'],
      tags: ['v1.0.0'],
      readme: '# demo plugin\n',
    })
    expect(engines.detailCalls.map(call => call.kind)).toEqual(['meta', 'branches', 'tags', 'readme'])
  })

  it('rejects an invalid repository slug with the github/bad-request wire code', async () => {
    const { gateway, engines } = gatewayWith()
    const caught = await gateway.repositoryDetail('not-a-slug').catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'github/bad-request' })
    expect(engines.detailCalls).toHaveLength(0)
  })

  it('forwards refKind to the source and derives per-tuple keys for same-name refs', async () => {
    const { gateway, engines } = gatewayWith()
    const branchReview = await gateway.previewInstall('octocat/demo-plugin', 'branch', 'v1.2.3')
    expect(branchReview).toMatchObject({ repository: 'octocat/demo-plugin', refKind: 'branch' })
    const tagReview = await gateway.previewInstall('octocat/demo-plugin', 'tag', 'v1.2.3')
    expect(tagReview.refKind).toBe('tag')
    expect(branchReview.key).not.toBe(tagReview.key)

    await downloadVia(gateway, 'octocat/demo-plugin', branchReview.confirmToken, 'branch', 'v1.2.3')
    await downloadVia(gateway, 'octocat/demo-plugin', tagReview.confirmToken, 'tag', 'v1.2.3')
    expect(engines.installCalls.map(call => call.key)).toEqual([branchReview.key, tagReview.key])
    expect(engines.installCalls.map(call => call.refKind)).toEqual(['branch', 'tag'])
  })

  it('maps a v2 ref-less preview to the market/bad-request wire code', async () => {
    const { gateway } = gatewayWith()
    const caught = await gateway.previewInstall('octocat/demo-plugin', 'tag', null).catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'market/bad-request' })
  })

  it('maps MarketControlError to a wire RemoteError with the stable code', () => {
    const error = new MarketControlError('market/confirm-expired', 'expired', { key: key('gh-x') })
    const remote = toRemoteError(error)
    expect(remote).toBeInstanceOf(RemoteError)
    expect(remoteErrorOf(remote)).toMatchObject({ code: 'market/confirm-expired', message: 'expired' })
    expect(remote.details).toEqual({ key: 'gh-x' })
  })

  it('rejects an invalid wire key with record/key-invalid', async () => {
    const { gateway } = gatewayWith()
    await expect(gateway.setEnabled('not a key', true)).rejects.toMatchObject({
      code: 'record/key-invalid',
    })
    const caught = await gateway.setEnabled('gh-nope', true).catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'record/not-found' })
  })

  it('surfaces the smart-install classification on an unconventional preview and still installs it', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'other', reason: 'an include-tree preset' }),
    })
    const { gateway, engines } = gatewayWith({ analysis, previewResult: degradedNoManifest })
    engines.installedEntry = null
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    expect(review.classification).toBe('other')
    expect(review.note).toEqual({ kind: 'classified', text: 'an include-tree preset' })
    expect(review.entryNote).toBe('an include-tree preset')
    expect(review.analysis).toEqual({ installable: false, kind: 'other', reason: 'an include-tree preset' })

    const outcome = await downloadVia(gateway, 'octocat/demo-plugin', review.confirmToken, null, null)
    expect(outcome.record).toMatchObject({ classification: 'other', entry: null })
    expect(outcome).toMatchObject({ classification: 'other', entry: null, dependenciesInstalled: false })
  })

  it('classifies an unconventional preview without an analysis engine as other (no refusal)', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const { gateway } = gatewayWith({ previewResult: degradedNoManifest })
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    expect(review.classification).toBe('other')
    // Localizable note instead of Host-authored prose: the client renders its
    // own copy for this kind.
    expect(review.note).toEqual({ kind: 'analysis-unavailable' })
    expect(review.entryNote).toBeUndefined()
  })

  it('degrades an unparsable analysis answer to the other classification on the gateway', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({
      error: new MarketError('market/llm-bad-output', 'the model returned prose, not JSON'),
    })
    const { gateway } = gatewayWith({ analysis, previewResult: degradedNoManifest })
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    expect(review.classification).toBe('other')
    expect(review.note).toEqual({ kind: 'analysis-unavailable' })
    await expect(downloadVia(gateway, 'octocat/demo-plugin', review.confirmToken, null, null))
      .resolves.toMatchObject({ key: key('gh-octocat-demo-plugin') })
  })

  it('maps a refused enable of a non-loadable record to the market/not-loadable wire code', async () => {
    const { gateway, records } = gatewayWith()
    const record = records.seed('gh-skills-pack', {
      enabled: false,
      localDirName: 'skills-pack',
      entry: null,
      classification: 'skills',
    })
    const caught = await gateway.setEnabled(String(record.key), true).catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({
      code: 'market/not-loadable',
      details: { key: 'gh-skills-pack', reason: 'classification' },
    })
    expect((await gateway.listManaged()).entries[0]).toMatchObject({ key: 'gh-skills-pack', loadable: false })
  })

  it('passes a prepare failure through over the gateway', async () => {
    const { gateway, engines } = gatewayWith()
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    engines.installError = new MarketError(
      'install/git-failed',
      'The git clone step failed (offline).',
    )
    const caught = await gateway.prepareDownload('octocat/demo-plugin', review.confirmToken, null, null)
      .catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'install/git-failed' })
  })

  it('carries the commit swap facts onto the wire details as stable reasons', async () => {
    const { gateway, engines } = gatewayWith()
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    const prepared = await gateway.prepareDownload('octocat/demo-plugin', review.confirmToken, null, null)

    // A pre-swap failure keeps the download retryable and says so on the wire.
    engines.commitError = new MarketError('install/io', 'the records file is locked')
    const retryable = await gateway.commitDownload(prepared.token, 'other').catch((error: unknown) => error)
    expect(remoteErrorOf(retryable)).toMatchObject({
      code: 'install/io',
      details: { key: 'gh-octocat-demo-plugin', reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })

    // The same handle then commits successfully.
    engines.commitError = undefined
    await expect(gateway.commitDownload(prepared.token, 'other')).resolves.toMatchObject({
      dependenciesInstalled: false,
    })

    // A post-swap failure is a repair: the host's checkoutDir travels as `path`.
    const second = await gateway.previewInstall('octocat/demo-plugin', null, null)
    const secondPrepared = await gateway.prepareDownload('octocat/demo-plugin', second.confirmToken, null, null)
    engines.commitError = new MarketError('install/io', 'the records file is locked')
    engines.commitFailsAfterSwap = true
    const repair = await gateway.commitDownload(secondPrepared.token, 'other').catch((error: unknown) => error)
    expect(remoteErrorOf(repair)).toMatchObject({
      code: 'install/io',
      details: {
        key: 'gh-octocat-demo-plugin',
        reason: DOWNLOAD_REASON_REPAIR_RECORD_STALE,
        path: '/repo/gh-octocat-demo-plugin',
      },
    })
  })

  it('distinguishes a swept download handle from a never-prepared one', async () => {
    let nowMs = 1_000
    const { gateway, engines } = gatewayWith({ now: () => new Date(nowMs), downloadTtlMs: 60_000 })
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    const prepared = await gateway.prepareDownload('octocat/demo-plugin', review.confirmToken, null, null)

    nowMs += 60_001
    const expired = await gateway.classifyDownload(prepared.token).catch((error: unknown) => error)
    expect(remoteErrorOf(expired)).toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED, path: prepared.token },
    })
    expect(engines.cancelledCalls).toEqual([prepared.token])

    const unknown = await gateway.classifyDownload('dl-0123456789abcdef0123456789abcdef')
      .catch((error: unknown) => error)
    expect(remoteErrorOf(unknown)).toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_UNKNOWN },
    })
  })

  it('bypasses analysis for standard plugins (ready preview never consults the engine)', async () => {
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'other', reason: 'never' }),
    })
    const { gateway, engines } = gatewayWith({ analysis })
    const review = await gateway.previewInstall('octocat/demo-plugin', 'branch', 'main')
    expect(review.classification).toBe('plugin')
    expect(review.analysis).toBeUndefined()
    expect(analysis.calls).toHaveLength(0)
    expect(engines.previewCalls).toEqual(['octocat/demo-plugin'])
  })
})