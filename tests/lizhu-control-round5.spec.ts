/**
 * Independent round-5 regression for plugin-control-service (Lizhu).
 *
 * Complements the shipped round-5 specs (control-source 51 / control-gateway 23
 * / control-webchannel 20) with the angles they leave open:
 * A. ensureStaged: warn on adoption, adopted-handle reuse, no re-stage on a
 *    plain handle, v2 recipe preservation, the download window NOT being
 *    extended by a re-stage, and a failed re-stage staying retryable.
 * B. retire on all cleanup paths: TTL sweep and same-key re-download after a
 *    re-stage (current host handle), the lazy expiry path, cancel on a
 *    pre-swap-failed handle, and the spent-handle bookkeeping limit.
 * C. The previousRemoved pre-swap sub-window with host failure shapes the fake
 *    cannot express (no facts at all, previousRemoved after the swap, missing
 *    checkoutDir, wrong-typed value) plus the wire filter.
 * D. The five DOWNLOAD_REASON_* values against the framework closed set.
 * E. The documented npm test five-segment gauntlet.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { MarketError } from '../src/host/market/errors.ts'
import type { MarketDownloadFailureReason } from '../src/types.ts'
import {
  DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
  DOWNLOAD_REASON_EXPIRED,
  DOWNLOAD_REASON_REPAIR_NO_RECORD,
  DOWNLOAD_REASON_REPAIR_RECORD_STALE,
  DOWNLOAD_REASON_UNKNOWN,
  MarketSourceOperations,
  wireDetailsOf,
} from '../src/host/control/source.ts'
import type { InstallerPort, MarketSourceDeps } from '../src/host/control/source.ts'
import { MarketControllerGateway } from '../lib/types/host/control/gateway.js'
import { key as keyOf, makeSourceOps, testbed } from './support/control-testbed.ts'
import type { Testbed } from './support/control-testbed.ts'

const SLUG = 'octocat/demo-plugin'
const GH_KEY = 'gh-octocat-demo-plugin'
const BAD_KEY = 'not-a-reason'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A source over an explicit installer port (the fakes one, or a wrapper). */
function sourceOverPort(
  bed: Testbed,
  port: InstallerPort,
  options: { now?: () => Date; downloadTtlMs?: number; warns?: string[] } = {},
): MarketSourceOperations {
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
      warn: (message) => { options.warns?.push(message) },
      error: () => {},
    },
  }
  return new MarketSourceOperations(deps)
}

/** The default fakes port, with commits answered by a scripted failure. */
function sourceWithCommitThrow(
  bed: Testbed,
  script: { readonly error: () => unknown; readonly times?: number },
  options: { now?: () => Date; warns?: string[] } = {},
): MarketSourceOperations {
  const base = bed.engines.installer(bed.records)
  let remaining = script.times ?? 1
  const port: InstallerPort = {
    ...base,
    commit: async (input) => {
      if (remaining > 0) {
        remaining -= 1
        throw script.error()
      }
      return await base.commit(input)
    },
  }
  return sourceOverPort(bed, port, options)
}

/** Host handles the fake download engine minted, in order. */
function hostTokens(bed: Testbed): string[] {
  return bed.engines.stagedCalls.filter(call => call.kind === 'prepare').map(call => call.token)
}

/** Drive one download to a pre-swap commit failure on the default fakes. */
async function failPreSwap(
  bed: Testbed,
  source: MarketSourceOperations,
): Promise<{ caller: string }> {
  const review = await source.previewInstall(SLUG)
  const prepared = await source.prepareDownload(SLUG, review.confirmToken)
  bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
  await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
    details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
  })
  bed.engines.commitError = undefined
  return { caller: prepared.token }
}

describe('round5 A: ensureStaged adoption and the caller handle', () => {
  it('re-stages lazily, warns, and classifies/commits the adopted host handle', async () => {
    const bed = testbed()
    const warns: string[] = []
    const source = sourceOverPort(bed, bed.engines.installer(bed.records), { warns })
    const { caller } = await failPreSwap(bed, source)
    expect(hostTokens(bed)).toHaveLength(1)

    const classification = await source.classifyDownload(caller)
    expect(classification.outcome).toBe('classified')
    const adopted = hostTokens(bed)[1]
    expect(hostTokens(bed)).toHaveLength(2)
    expect(adopted).toBeDefined()
    expect(adopted).not.toBe(caller)
    expect(warns.some(message => message.includes('re-staged'))).toBe(true)

    const outcome = await source.commitDownload(caller, classification.classification)
    expect(outcome.key).toBe(keyOf(GH_KEY))
    const commits = bed.engines.stagedCalls.filter(call => call.kind === 'commit')
    expect(commits.map(call => call.token)).toEqual([caller, adopted])
    expect(hostTokens(bed)).toHaveLength(2)
  })

  it('a second classify reuses the adopted handle instead of cloning again', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const { caller } = await failPreSwap(bed, source)

    await expect(source.classifyDownload(caller)).resolves.toMatchObject({ outcome: 'classified' })
    await expect(source.classifyDownload(caller)).resolves.toMatchObject({ outcome: 'classified' })
    expect(hostTokens(bed)).toHaveLength(2)
    const classifyTokens = bed.engines.stagedCalls.filter(call => call.kind === 'classify').map(call => call.token)
    expect(classifyTokens).toEqual([hostTokens(bed)[1], hostTokens(bed)[1]])
  })

  it('never re-stages a plain handle (classify twice and commit clone exactly once)', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    await source.classifyDownload(prepared.token)
    await source.classifyDownload(prepared.token)
    await source.commitDownload(prepared.token, 'plugin')
    expect(hostTokens(bed)).toEqual([prepared.token])
  })

  it('a re-stage replays the v2 recipe (refKind and ref preserved)', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const review = await source.previewInstall(SLUG, 'tag', 'v1.0.0')
    const prepared = await source.prepareDownload(SLUG, review.confirmToken, 'tag', 'v1.0.0')

    bed.engines.commitError = new MarketError('install/io', 'locked')
    await expect(source.commitDownload(prepared.token, 'plugin')).rejects.toMatchObject({
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })
    bed.engines.commitError = undefined
    await source.classifyDownload(prepared.token)

    expect(bed.engines.installCalls).toHaveLength(2)
    expect(bed.engines.installCalls[1]).toMatchObject({
      repositoryRoot: '/repo',
      repository: SLUG,
      refKind: 'tag',
      version: 'v1.0.0',
    })
  })

  it('a re-stage does not extend the download window (the deadline is preserved)', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      now: () => new Date(nowMs),
      downloadTtlMs: 60_000,
    })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    bed.engines.commitError = new MarketError('install/io', 'locked')
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toBeDefined()
    bed.engines.commitError = undefined
    nowMs += 30_000
    await expect(source.classifyDownload(prepared.token)).resolves.toBeDefined()

    nowMs += 30_000
    await expect(source.classifyDownload(prepared.token)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
  })

  it('a failed re-stage surfaces the host failure and stays retryable', async () => {
    const bed = testbed()
    const warns: string[] = []
    const base = bed.engines.installer(bed.records)
    let failPrepare = false
    const port: InstallerPort = {
      ...base,
      prepare: async (input) => {
        if (failPrepare) throw new MarketError('install/git-failed', 'offline')
        return await base.prepare(input)
      },
    }
    const source = sourceOverPort(bed, port, { warns })
    const { caller } = await failPreSwap(bed, source)

    failPrepare = true
    await expect(source.classifyDownload(caller)).rejects.toMatchObject({ code: 'install/git-failed' })

    failPrepare = false
    await expect(source.classifyDownload(caller)).resolves.toMatchObject({ outcome: 'classified' })
    expect(hostTokens(bed)).toHaveLength(2)
  })
})

describe('round5 B: retire on every cleanup path', () => {
  it('a TTL sweep after a re-stage cancels the CURRENT host handle', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      now: () => new Date(nowMs),
      downloadTtlMs: 60_000,
    })
    const { caller } = await failPreSwap(bed, source)
    await source.classifyDownload(caller)
    const current = hostTokens(bed)[1]
    expect(bed.engines.cancelledCalls).toEqual([])

    nowMs += 60_000
    await source.previewInstall('octocat/other-plugin')
    expect(bed.engines.cancelledCalls).toEqual([current])
    await expect(source.classifyDownload(caller)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
  })

  it('a same-key re-download after a re-stage discards the CURRENT host handle', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const { caller } = await failPreSwap(bed, source)
    await source.classifyDownload(caller)
    const current = hostTokens(bed)[1]

    const again = await source.previewInstall(SLUG)
    await source.prepareDownload(SLUG, again.confirmToken)
    expect(bed.engines.cancelledCalls).toEqual([current])
    await expect(source.classifyDownload(caller)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
  })

  // Regression pin for the round-5 defect (medium-low severity, now FIXED).
  //
  // The lazy expiry inside `requireDownload` (source.ts, the `now >= entry.expiresAt`
  // branch) used to retire with the CALLER token:
  //     this.downloads.delete(token); this.spentHandles.add(token)
  //     await this.cancelStaging(entry.key, token)
  // After a re-stage the live host handle is `entry.token` (a different string),
  // so nothing was actually cancelled — and the host had dropped the caller's
  // handle when the commit failed, so `cancel(caller)` was a no-op. Result: the
  // re-staged staging directory was orphaned (disk residue) and `entry.token`
  // never entered `spentHandles`, contradicting the method's own contract
  // ("its staging is cancelled and it is remembered as spent"). The branch now
  // mirrors the TTL sweep path: `retire(token, entry.token)` +
  // `cancelStaging(entry.key, entry.token)`.
  it('lazy TTL expiry after a re-stage cancels the CURRENT host handle', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      now: () => new Date(nowMs),
      downloadTtlMs: 60_000,
    })
    const { caller } = await failPreSwap(bed, source)
    await source.classifyDownload(caller)
    const current = hostTokens(bed)[1]
    expect(current).toBeDefined()

    // No review happens here: the expiry is discovered lazily by the phase call.
    nowMs += 60_000
    await expect(source.classifyDownload(caller)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
    expect(bed.engines.cancelledCalls).toEqual([current])
  })

  it('cancelling a pre-swap-failed handle answers false yet keeps it retryable', async () => {
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines)
    const { caller } = await failPreSwap(bed, source)

    await expect(source.cancelDownload(caller)).resolves.toBe(false)
    await expect(source.classifyDownload(caller)).resolves.toMatchObject({ outcome: 'classified' })
    await expect(source.commitDownload(caller, 'other')).resolves.toMatchObject({ key: keyOf(GH_KEY) })
  })

  it('the spent-handle bookkeeping stays bounded and keeps the newest reasons accurate', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      now: () => new Date(nowMs),
      downloadTtlMs: 60_000,
    })

    const callers: string[] = []
    for (let index = 0; index < 70; index += 1) {
      const slug = `octocat/pkg-${String(index)}`
      const review = await source.previewInstall(slug)
      const prepared = await source.prepareDownload(slug, review.confirmToken)
      callers.push(prepared.token)
    }
    expect(callers).toHaveLength(70)

    nowMs += 60_000
    await source.previewInstall('octocat/other-plugin')
    expect(bed.engines.cancelledCalls).toHaveLength(70)

    await expect(source.classifyDownload(callers[0]!)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_UNKNOWN },
    })
    await expect(source.classifyDownload(callers[69]!)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
  })
})

describe('round5 C: the pre-swap sub-window and the wire filter', () => {
  it('a failure carrying no swap facts at all is the harmless pre-swap form', async () => {
    const bed = testbed()
    const source = sourceWithCommitThrow(bed, { error: () => new MarketError('install/io', 'locked') })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    const failure = await source.commitDownload(prepared.token, 'other').catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'install/io',
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP, key: GH_KEY },
    })
    const details = (failure as { details: Record<string, unknown> }).details
    expect(details.path).toBeUndefined()
    expect(Object.keys(details).sort()).toEqual(['key', 'reason'])
    expect((failure as Error).message).toContain('are unchanged')

    await expect(source.commitDownload(prepared.token, 'other')).resolves.toMatchObject({ key: keyOf(GH_KEY) })
  })

  it('previousRemoved is ignored once the swap happened (repair routing wins)', async () => {
    const bed = testbed()
    const source = sourceWithCommitThrow(bed, {
      error: () => new MarketError('install/io', 'locked', {
        details: { swapCompleted: true, previousRemoved: true, checkoutDir: '/repo/checkout-x' },
      }),
    })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    const failure = await source.commitDownload(prepared.token, 'other').catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'install/io',
      details: { reason: DOWNLOAD_REASON_REPAIR_NO_RECORD, key: GH_KEY, path: '/repo/checkout-x' },
    })
    expect((failure as Error).message).not.toContain('ALREADY been deleted')
    expect((failure as Error).message).toContain('removed by hand')
  })

  it('a destructive pre-swap failure without a checkoutDir carries no path', async () => {
    const bed = testbed()
    const source = sourceWithCommitThrow(bed, {
      error: () => new MarketError('install/io', 'locked', {
        details: { swapCompleted: false, previousRemoved: true },
      }),
    })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    const failure = await source.commitDownload(prepared.token, 'other').catch((error: unknown) => error)
    expect((failure as Error).message).toContain('ALREADY been deleted')
    const details = (failure as { details: Record<string, unknown> }).details
    expect(details.reason).toBe(DOWNLOAD_REASON_COMMIT_BEFORE_SWAP)
    expect(details.path).toBeUndefined()
  })

  it('a wrong-typed previousRemoved is treated as absent', async () => {
    const bed = testbed()
    const source = sourceWithCommitThrow(bed, {
      error: () => new MarketError('install/io', 'locked', {
        details: { swapCompleted: false, previousRemoved: 'yes' as unknown as boolean, checkoutDir: '/repo/c' },
      }),
    })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    const failure = await source.commitDownload(prepared.token, 'other').catch((error: unknown) => error)
    expect((failure as Error).message).toContain('are unchanged')
    expect((failure as Error).message).not.toContain('ALREADY been deleted')
    expect((failure as { details: Record<string, unknown> }).details.path).toBeUndefined()
  })

  it('wireDetailsOf never lets previousRemoved or a wrong-typed path through', () => {
    const host = new MarketError('install/io', 'locked', {
      details: { swapCompleted: false, previousRemoved: true, checkoutDir: '/repo/kept', key: 'gh-k', reason: 'r' },
    })
    expect(wireDetailsOf(host)).toEqual({ key: 'gh-k', path: '/repo/kept', reason: 'r' })

    const wrongPath = new MarketError('install/io', 'locked', {
      details: { previousRemoved: true, path: 7, checkoutDir: '/repo/kept', reason: 'r' },
    })
    expect(wireDetailsOf(wrongPath)).toEqual({ path: '/repo/kept', reason: 'r' })
  })

  it('the repair routing survives the Gateway with only key/path/reason on the wire', async () => {
    const bed = testbed()
    const ctx = new Context()
    contexts.push(ctx)
    const source = sourceWithCommitThrow(bed, {
      error: () => new MarketError('install/io', 'locked', {
        details: { swapCompleted: true, previousRemoved: true, checkoutDir: '/repo/checkout-x' },
      }),
    })
    const deps = {
      controller: () => bed.controller(),
      repository: () => bed.repository,
      source,
    } as unknown as import('../lib/types/host/control/gateway.js').MarketControllerGatewayDeps
    const gateway = new MarketControllerGateway(ctx, deps)

    const review = await gateway.previewInstall(SLUG, null, null)
    const prepared = await gateway.prepareDownload(SLUG, review.confirmToken, null, null)
    const remote = remoteErrorOf(await gateway.commitDownload(prepared.token, 'other').catch((error: unknown) => error))
    expect(remote).toMatchObject({
      code: 'install/io',
      details: { key: GH_KEY, reason: DOWNLOAD_REASON_REPAIR_NO_RECORD, path: '/repo/checkout-x' },
    })
    expect(Object.keys(remote?.details ?? {}).sort()).toEqual(['key', 'path', 'reason'])
  })
})

describe('round5 D/E: closed reason set and the test gauntlet', () => {
  it('the five download reasons are exactly the framework closed set', () => {
    const members: readonly MarketDownloadFailureReason[] = [
      DOWNLOAD_REASON_UNKNOWN,
      DOWNLOAD_REASON_EXPIRED,
      DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
      DOWNLOAD_REASON_REPAIR_NO_RECORD,
      DOWNLOAD_REASON_REPAIR_RECORD_STALE,
    ]
    expect(members).toEqual([
      'download-unknown',
      'download-expired',
      'commit-before-swap',
      'repair:checkout-committed-no-record',
      'repair:checkout-committed-record-stale',
    ])
    expect(new Set(members).size).toBe(5)
  })

  it('the closed set is not widened from this module (compile-time pin)', () => {
    // @ts-expect-error a sixth value is not a member of the framework closed set
    const widened: MarketDownloadFailureReason = BAD_KEY
    expect(widened).toBe(BAD_KEY)
  })

  it('npm test is the documented five-segment gauntlet', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> }
    const segments = manifest.scripts['test']!.split('&&').map(part => part.trim())
    expect(segments).toEqual([
      'node scripts/check-encoding.mjs',
      'node scripts/check-encoding.mjs --self-test',
      'tsc -b tsconfig.json',
      'tsc -p tsconfig.test.json --noEmit',
      'vitest run',
    ])
    expect(manifest.scripts['build']).toBe('tsc -b tsconfig.json && tsdown')
    expect(manifest.scripts['verify']).toBe('node scripts/verify-load.mjs')
  })
})