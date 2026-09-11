/**
 * Independent round-4 regression for plugin-control-service (Lizhu).
 *
 * Covers only verdicts the shipped specs leave untouched:
 * 1. Split registries / independent download TTL: default 10-minute boundary,
 *    a download window shorter than the review window governing on its own,
 *    and previewInstall's sweepStale() really cancelling host staging (while
 *    never touching a download that is still inside its own window).
 * 2. Re-preparing the same plugin key explicitly discards the previous staging
 *    and logs a warning; a mere re-preview only replaces the review.
 * 3. commitDownload routing by the host swap fact: handle consumption semantics
 *    and operator guidance for both repair forms.
 * 4. wireDetailsOf normalization: only key/path/reason travel, path falls back
 *    to checkoutDir, host extras (swapCompleted/token) never reach the wire,
 *    and both Gateway branches (MarketError and structural) go through it.
 * 5. The Gateway @Remote method set stays the same 13 methods in order.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MarketError } from '../src/host/market/errors.ts'
import { pluginKeyForGithubRef } from '../src/host/market/keys.ts'
import { MarketControlError, REMOVE_CONFIRM_TTL_MS } from '../src/host/control/controller.ts'
import {
  DEFAULT_DOWNLOAD_TTL_MS,
  DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
  DOWNLOAD_REASON_EXPIRED,
  DOWNLOAD_REASON_REPAIR_NO_RECORD,
  DOWNLOAD_REASON_UNKNOWN,
  MarketSourceOperations,
  wireDetailsOf,
} from '../src/host/control/source.ts'
import type { MarketSourceDeps } from '../src/host/control/source.ts'
import { toRemoteError } from '../lib/types/host/control/gateway.js'
import { MarketControllerGateway } from '../lib/types/host/control/gateway.js'
import { key as keyOf, makeSourceOps, testbed } from './support/control-testbed.ts'
import type { Testbed } from './support/control-testbed.ts'

/** Repository slug and its derived legacy key under test. */
const SLUG = 'octocat/demo-plugin'
const GH_KEY = 'gh-octocat-demo-plugin'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Gateway over the shared fakes (mirrors the shipped gateway spec fixture). */
function gatewayWith(options: { now?: () => Date; downloadTtlMs?: number } = {}): {
  gateway: MarketControllerGateway
  bed: Testbed
} {
  const ctx = new Context()
  contexts.push(ctx)
  const bed = testbed()
  const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.downloadTtlMs === undefined ? {} : { downloadTtlMs: options.downloadTtlMs }),
  })
  const deps = {
    controller: () => bed.controller(),
    repository: () => bed.repository,
    source,
  } as unknown as import('../lib/types/host/control/gateway.js').MarketControllerGatewayDeps
  return { gateway: new MarketControllerGateway(ctx, deps), bed }
}

/**
 * A source over the shared fakes whose logger records every message, so the
 * discard warning of the split registries is observable.
 */
function opsWithLogs(
  bed: Testbed,
  options: { now?: () => Date; downloadTtlMs?: number } = {},
): { source: MarketSourceOperations; warns: string[]; errors: string[] } {
  const port = bed.engines.installer(bed.records)
  const warns: string[] = []
  const errors: string[] = []
  const deps: MarketSourceDeps = {
    repository: () => bed.repository,
    searchEngine: bed.engines.searchEngine,
    detailEngine: bed.engines.detailEngine,
    previewEngine: bed.engines.previewEngine,
    installer: () => port,
    protection: { isProtectedKey: () => false, isSelfModule: () => false },
    syncRecord: bed.engines.syncRecord,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.downloadTtlMs === undefined ? {} : { downloadTtlMs: options.downloadTtlMs }),
    logger: {
      warn: (message) => { warns.push(message) },
      error: (message) => { errors.push(message) },
    },
  }
  return { source: new MarketSourceOperations(deps), warns, errors }
}

describe('round4: wireDetailsOf normalization (host extras never reach the wire)', () => {
  it('passes only key/path/reason: checkoutDir folds into path, swapCompleted/token are stripped', () => {
    const host = new MarketError('install/io', 'the records file is locked', {
      details: {
        swapCompleted: true,
        checkoutDir: '/repo/gh-octocat-demo-plugin',
        token: 'dl-secret-handle',
        key: 'gh-octocat-demo-plugin',
        reason: DOWNLOAD_REASON_REPAIR_NO_RECORD,
      },
    })
    const details = wireDetailsOf(host)
    expect(details).toEqual({
      key: 'gh-octocat-demo-plugin',
      path: '/repo/gh-octocat-demo-plugin',
      reason: DOWNLOAD_REASON_REPAIR_NO_RECORD,
    })
    expect(Object.keys(details).sort()).toEqual(['key', 'path', 'reason'])
    expect(details).not.toHaveProperty('swapCompleted')
    expect(details).not.toHaveProperty('token')
    expect(details).not.toHaveProperty('checkoutDir')
  })

  it('an explicit path wins over the checkoutDir fallback', () => {
    const host = new MarketError('install/io', 'x', {
      details: { path: '/explicit', checkoutDir: '/fallback', reason: 'r' },
    })
    expect(wireDetailsOf(host)).toEqual({ path: '/explicit', reason: 'r' })
  })

  // Regression pin for the round-4 defect (low severity, now FIXED): the old
  // trailing spread (`errorDetails?.key !== undefined && detailsKey === undefined`)
  // could only fire when `details.key` was present and NOT a string — the very
  // case the string guards above just rejected — so a host (or foreign-copy)
  // failure carrying `details.key = 42` shipped `{ key: 42 }` to the wire. The
  // spread was redundant (`errorDetails` is the same object as `details`) and has
  // been deleted, so this is now a plain assertion: wrong-typed values are
  // dropped, never forwarded.
  it('drops non-string fields instead of shipping arbitrary host values', () => {
    const host = new MarketError('install/io', 'x', {
      details: { key: 42, reason: null, token: 'dl-t', swapCompleted: false },
    })
    expect(wireDetailsOf(host)).toEqual({})
  })

  it('answers empty details for failures that carry none', () => {
    expect(wireDetailsOf(new Error('plain'))).toEqual({})
    expect(wireDetailsOf('boom')).toEqual({})
    expect(wireDetailsOf(null)).toEqual({})
    expect(wireDetailsOf(undefined)).toEqual({})
  })

  it('keeps the control layer own MarketControlError details as-is', () => {
    expect(wireDetailsOf(new MarketControlError('record/not-found', 'x', {
      path: 'dl-1',
      reason: DOWNLOAD_REASON_UNKNOWN,
    }))).toEqual({ path: 'dl-1', reason: DOWNLOAD_REASON_UNKNOWN })
  })

  it('Gateway MarketError branch: host swap facts and tokens stay off the wire', () => {
    const remote = toRemoteError(new MarketError('install/io', 'locked', {
      details: {
        swapCompleted: false,
        checkoutDir: '/repo/x',
        token: 'dl-t',
        key: 'gh-k',
        reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
      },
    }))
    expect(remoteErrorOf(remote)).toMatchObject({
      code: 'install/io',
      details: { key: 'gh-k', path: '/repo/x', reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })
    const details = (remote as unknown as { details: Record<string, unknown> }).details
    expect(details).not.toHaveProperty('swapCompleted')
    expect(details).not.toHaveProperty('token')
    expect(details).not.toHaveProperty('checkoutDir')
  })

  it('Gateway structural branch (a failure from another package copy) normalizes the same way', () => {
    const foreign = {
      code: 'install/io',
      message: 'from another copy of the package',
      details: { swapCompleted: true, token: 'dl-x', key: 'gh-k', reason: 'r' },
    }
    const remote = toRemoteError(foreign)
    expect(remoteErrorOf(remote)).toMatchObject({ code: 'install/io', details: { key: 'gh-k', reason: 'r' } })
    expect((remote as unknown as { details: Record<string, unknown> }).details)
      .not.toHaveProperty('swapCompleted')
  })

  it('end to end: a host failure behind gateway.search is normalized before it travels', async () => {
    const { gateway, bed } = gatewayWith()
    bed.engines.searchError = new MarketError('github/network', 'offline', {
      details: { token: 'dl-t', swapCompleted: true, checkoutDir: '/repo/c', reason: 'r' },
    })
    const caught = await gateway.search('demo', null, null).catch((error: unknown) => error)
    expect(remoteErrorOf(caught)).toMatchObject({ code: 'github/network', details: { path: '/repo/c', reason: 'r' } })
    expect((remoteErrorOf(caught) as unknown as { details: Record<string, unknown> }).details)
      .not.toHaveProperty('swapCompleted')
  })

  it('the Gateway @Remote method set stays the same 13 methods in order', () => {
    const { gateway } = gatewayWith()
    expect(remoteMethods(gateway).map(entry => entry.method)).toEqual([
      'status', 'listManaged', 'setEnabled', 'requestRemove', 'confirmRemove',
      'search', 'repositoryDetail', 'previewInstall', 'prepareDownload',
      'classifyDownload', 'commitDownload', 'cancelDownload', 'setClassification',
    ])
  })
})

describe('round4: boundaries of the independent download TTL', () => {
  it('defaults to ten minutes from prepare: usable just before, expired and swept at the deadline', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { now: () => new Date(nowMs) })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    expect(DEFAULT_DOWNLOAD_TTL_MS).toBe(600_000)

    nowMs += DEFAULT_DOWNLOAD_TTL_MS - 1
    await expect(source.classifyDownload(prepared.token)).resolves.toMatchObject({ outcome: 'classified' })
    expect(bed.engines.cancelledCalls).toEqual([])

    nowMs += 1
    const error = await source.classifyDownload(prepared.token).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED, path: prepared.token },
    })
    expect(bed.engines.cancelledCalls).toEqual([prepared.token])
  })

  it('a download window shorter than the review window governs on its own', async () => {
    expect(REMOVE_CONFIRM_TTL_MS).toBeGreaterThan(5_000)
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      now: () => new Date(nowMs),
      downloadTtlMs: 5_000,
    })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    nowMs += 5_000
    const error = await source.classifyDownload(prepared.token).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED, path: prepared.token },
    })
    expect(bed.engines.cancelledCalls).toEqual([prepared.token])
  })

  it('previewInstall sweep cancels staging past its own deadline and spares live downloads', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      now: () => new Date(nowMs),
      downloadTtlMs: 60_000,
    })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    // One more review inside the review window must not disturb the download.
    nowMs += 30_000
    await source.previewInstall(SLUG)
    expect(bed.engines.cancelledCalls).toEqual([])

    // Past the download window a single previewInstall sweep cancels the host
    // staging by itself (no classify/commit call involved).
    nowMs += 30_000
    await source.previewInstall(SLUG)
    expect(bed.engines.cancelledCalls).toEqual([prepared.token])

    const expired = await source.classifyDownload(prepared.token).catch((e: unknown) => e)
    expect(expired).toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED, path: prepared.token },
    })
    expect((expired as Error).message).toContain('cleaned up')

    // A handle that was never prepared still reports the unknown reason.
    const unknown = await source.classifyDownload('dl-ffffffffffffffffffffffffffffffff').catch((e: unknown) => e)
    expect(unknown).toMatchObject({ code: 'record/not-found', details: { reason: DOWNLOAD_REASON_UNKNOWN } })
    expect((unknown as Error).message).toContain('unknown')
  })
})

describe('round4: same-key re-review / re-prepare cleanup semantics', () => {
  it('a re-review only replaces the review; only a re-prepare discards the previous staging with a warning', async () => {
    const bed = testbed()
    const { source, warns } = opsWithLogs(bed)
    const first = await source.previewInstall(SLUG)
    const firstPrepared = await source.prepareDownload(SLUG, first.confirmToken)

    // Re-reviewing the same key must never clobber a download in progress.
    const second = await source.previewInstall(SLUG)
    expect(bed.engines.cancelledCalls).toEqual([])
    expect(second.confirmToken).not.toBe(first.confirmToken)

    // Re-preparing the same key explicitly discards the previous staging.
    const secondPrepared = await source.prepareDownload(SLUG, second.confirmToken)
    expect(secondPrepared.token).not.toBe(firstPrepared.token)
    expect(bed.engines.cancelledCalls).toEqual([firstPrepared.token])
    expect(warns.some(message => message.includes('downloaded again') && message.includes('discarded'))).toBe(true)

    // The old handle reports the swept reason; the new one stays fully usable.
    await expect(source.classifyDownload(firstPrepared.token)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
    const outcome = await source.commitDownload(secondPrepared.token, 'other')
    expect(outcome.key).toBe(keyOf(GH_KEY))
  })

  it('the review confirmation is single use: preparing again with the same token is confirm-required', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const review = await source.previewInstall(SLUG)
    await source.prepareDownload(SLUG, review.confirmToken)
    await expect(source.prepareDownload(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'market/confirm-required',
    })
  })
})

describe('round4: commit failures route by the host swap fact', () => {
  it('pre-swap failure: the same token retries from the kept recipe (v2 ref preserved)', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const review = await source.previewInstall(SLUG, 'tag', 'v1.0.0')
    const prepared = await source.prepareDownload(SLUG, review.confirmToken, 'tag', 'v1.0.0')

    bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
    const failure = await source.commitDownload(prepared.token, 'plugin').catch((e: unknown) => e)
    expect(failure).toMatchObject({
      code: 'install/io',
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })
    expect((failure as Error).message).toContain('Retry the commit with the same download handle')

    // The retry re-stages from the kept recipe before committing again.
    bed.engines.commitError = undefined
    const outcome = await source.commitDownload(prepared.token, 'plugin')
    expect(outcome.key).toBe(pluginKeyForGithubRef(SLUG, 'tag', 'v1.0.0'))
    expect(bed.engines.installCalls).toHaveLength(2)
    expect(bed.engines.installCalls[1]).toMatchObject({
      repositoryRoot: '/repo',
      repository: SLUG,
      refKind: 'tag',
      version: 'v1.0.0',
    })
  })

  it('post-swap failure: the handle is consumed (no retry, cancel false) and guides a manual repair', async () => {
    const bed = testbed()
    const { source, errors } = opsWithLogs(bed)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
    bed.engines.commitFailsAfterSwap = true
    const failure = await source.commitDownload(prepared.token, 'other').catch((e: unknown) => e)
    expect(failure).toMatchObject({
      code: 'install/io',
      details: {
        reason: DOWNLOAD_REASON_REPAIR_NO_RECORD,
        key: GH_KEY,
        path: `/repo/${GH_KEY}`,
      },
    })
    expect((failure as Error).message).toContain('removed by hand')
    expect(errors.some(message => message.includes(DOWNLOAD_REASON_REPAIR_NO_RECORD))).toBe(true)

    // Consumed handle: no retry, nothing left to cancel, and no record filed.
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({ code: 'record/not-found' })
    await expect(source.cancelDownload(prepared.token)).resolves.toBe(false)
    expect(await bed.records.list()).toEqual([])
  })

  it('a pre-swap failure stays retryable for the whole download window', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      now: () => new Date(nowMs),
      downloadTtlMs: 60_000,
    })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    bed.engines.commitError = new MarketError('install/io', 'locked')
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })

    // 59s after the original prepare the handle is still inside its window.
    nowMs += 59_000
    bed.engines.commitError = undefined
    await expect(source.commitDownload(prepared.token, 'other')).resolves.toMatchObject({ key: keyOf(GH_KEY) })
  })

  // Single consumption (round-4 observation, tightened afterwards): a SUCCESSFUL
  // re-staged retry retires the NEW host handle AND the ORIGINAL token whose
  // entry was flagged `restage`. Committing the original token again must NOT
  // clone the repository a third time — it reports the handle as consumed.
  it('a successful re-staged retry retires the original handle too (single consumption)', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    bed.engines.commitError = new MarketError('install/io', 'locked')
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })

    bed.engines.commitError = undefined
    await expect(source.commitDownload(prepared.token, 'other')).resolves.toMatchObject({ key: keyOf(GH_KEY) })
    // Two prepares so far (the original and the retry's re-stage).
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(2)

    // The original handle is consumed: no third clone, and the failure names it
    // as a lost handle rather than silently committing again.
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
    await expect(source.cancelDownload(prepared.token)).resolves.toBe(false)
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(2)
  })
})