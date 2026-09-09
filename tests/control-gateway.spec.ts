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
// @ts-expect-error -- compiled artifact (see header note)
import {
  MARKET_CONTROL_SERVICE_KEY,
  MarketControllerGateway,
  toRemoteError,
} from '../lib/types/host/control/gateway.js'
// @ts-expect-error -- compiled artifact (see header note)
import { MarketControlError } from '../lib/types/host/control/controller.js'
import { MarketError } from '../src/host/market/errors.ts'
import {
  fakeAnalysisEngine,
  key,
  makeSourceOps,
  testbed,
} from './support/control-testbed.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function gatewayWith(
  options: {
    idle?: boolean
    analysis?: InstallAnalysisEngine
    previewResult?: import('../src/types.ts').PluginPreviewOutcome
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
  })
  const gateway = new MarketControllerGateway(ctx, {
    controller: () => controller,
    repository: () => repository,
    source,
  })
  return { ctx, gateway, engines: bed.engines, records: bed.records }
}

describe('MarketControllerGateway host Remote surface', () => {
  it('publishes the marketControl namespace with nine direct methods', () => {
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
      { method: 'install', invocation: { kind: 'direct' } },
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
    const idleSearch = await gateway.search('demo', null).catch((error: unknown) => error)
    expect(remoteErrorOf(idleSearch)).toMatchObject({ code: 'market/idle' })
    const idleInstall = await gateway.install('octocat/demo', 'tok', null, null).catch((error: unknown) => error)
    expect(remoteErrorOf(idleInstall)).toMatchObject({ code: 'market/idle' })
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

    await gateway.install('octocat/demo-plugin', branchReview.confirmToken, 'branch', 'v1.2.3')
    await gateway.install('octocat/demo-plugin', tagReview.confirmToken, 'tag', 'v1.2.3')
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

  it('surfaces the smart-install refusal on an unconventional preview and rejects its install', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({
      result: { installable: false, kind: 'preset', reason: 'an include-tree preset' },
    })
    const { gateway } = gatewayWith({ analysis, previewResult: degradedNoManifest })
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    expect(review.analysis).toEqual({ installable: false, kind: 'preset', reason: 'an include-tree preset' })
    const refusal = await gateway.install('octocat/demo-plugin', review.confirmToken, null, null)
      .catch((error: unknown) => error)
    expect(remoteErrorOf(refusal)).toMatchObject({
      code: 'market/unsupported-preset',
      message: 'an include-tree preset',
    })
  })

  it('answers llm-unconfigured over the gateway when an unconventional preview has no analysis engine', async () => {
    const degradedNoManifest: import('../src/types.ts').PluginPreviewOutcome = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const { gateway } = gatewayWith({ previewResult: degradedNoManifest })
    const caught = await gateway.previewInstall('octocat/demo-plugin', null, null).catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'market/llm-unconfigured' })
  })

  it('normalizes an unparsable analysis answer to the stable retryable market/llm-failed on the gateway', async () => {
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
    const caught = await gateway.previewInstall('octocat/demo-plugin', null, null).catch((error: unknown) => error)
    // LLM jitter surfaces as one stable code the UI can retry, not as the
    // internal llm-bad-output or a transport error.
    expect(remoteErrorOf(caught)).toMatchObject({
      code: 'market/llm-failed',
      message: expect.stringMatching(/retry/i),
    })
  })

  it('surfaces install/entry-missing with a build-first hint over the gateway', async () => {
    const { gateway, engines } = gatewayWith()
    const review = await gateway.previewInstall('octocat/demo-plugin', null, null)
    engines.installError = new MarketError(
      'install/entry-missing',
      'The resolved plugin entry "dist/index.js" does not exist inside the checkout.',
    )
    const caught = await gateway.install('octocat/demo-plugin', review.confirmToken, null, null)
      .catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({
      code: 'install/entry-missing',
      message: expect.stringContaining('documented build step'),
    })
  })

  it('bypasses analysis for standard plugins (ready preview never consults the engine)', async () => {
    const analysis = fakeAnalysisEngine({ result: { installable: false, kind: 'other', reason: 'never' } })
    const { gateway, engines } = gatewayWith({ analysis })
    const review = await gateway.previewInstall('octocat/demo-plugin', 'branch', 'main')
    expect(review.analysis).toBeUndefined()
    expect(analysis.calls).toHaveLength(0)
    expect(engines.previewCalls).toEqual(['octocat/demo-plugin'])
  })
})