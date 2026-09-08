import { describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import { REMOVE_CONFIRM_TTL_MS } from '../src/host/control/controller.ts'
import { key, makeSourceOps, testbed } from './support/control-testbed.ts'

/** Repository slug → derived key convention under test. */
const SLUG = 'octocat/demo-plugin'
const GH_KEY = 'gh-octocat-demo-plugin'

type Bed = ReturnType<typeof testbed>

/** One source over the shared fakes of a testbed. */
function ops(
  bed: Bed,
  options: { idle?: boolean; now?: () => Date; isProtectedKey?: (k: string) => boolean } = {},
) {
  return makeSourceOps(
    options.idle === true ? null : bed.repository,
    bed.records,
    bed.engines,
    {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.isProtectedKey === undefined ? {} : { isProtectedKey: options.isProtectedKey }),
    },
  )
}

describe('MarketSourceOperations search', () => {
  it('answers market/idle for every operation without a configured repository', async () => {
    const bed = testbed()
    const source = ops(bed, { idle: true })
    await expect(source.search({ keywords: 'demo' })).rejects.toMatchObject({ code: 'market/idle' })
    await expect(source.previewInstall(SLUG)).rejects.toMatchObject({ code: 'market/idle' })
    await expect(source.install(SLUG, 'tok')).rejects.toMatchObject({ code: 'market/idle' })
  })

  it('passes search options through and returns the engine page', async () => {
    const bed = testbed()
    const source = ops(bed)
    const page = await source.search({ keywords: 'agents', perPage: 3, page: 2 })
    expect(page).toEqual({ totalCount: 0, items: [] })
    expect(bed.engines.searchCalls).toEqual([{ keywords: 'agents', perPage: 3, page: 2 }])
  })

  it('defaults an omitted page to 1', async () => {
    const bed = testbed()
    const source = ops(bed)
    await source.search({ keywords: 'agents' })
    expect(bed.engines.searchCalls).toEqual([{ keywords: 'agents', page: 1 }])
  })

  it('forwards oversized pages unchanged (host GitHubMarket clamps 1..1e6)', async () => {
    const bed = testbed()
    const source = ops(bed)
    await source.search({ page: 1_000_001 })
    expect(bed.engines.searchCalls).toEqual([{ page: 1_000_001 }])
  })

  it('propagates engine failures with their stable github/* codes', async () => {
    const bed = testbed()
    bed.engines.searchError = new MarketError('github/network', 'offline', { path: 'https://api.github.com' })
    const source = ops(bed)
    await expect(source.search({ keywords: 'demo' })).rejects.toMatchObject({ code: 'github/network' })
  })
})

describe('MarketSourceOperations previewInstall', () => {
  it('reports ready preview and mints a confirmation token for a new plugin', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    expect(review.repository).toBe(SLUG)
    expect(review.key).toBe(key(GH_KEY))
    expect(review.preview.status).toBe('ready')
    expect(review.exists).toBe(false)
    expect(review.overwrite).toBe(false)
    expect(review.existing).toBeNull()
    expect(review.confirmToken).toBeTruthy()
    expect(Date.parse(review.expiresAt)).toBeGreaterThan(0)
  })

  it('flags an already-managed plugin as an overwrite update', async () => {
    const bed = testbed()
    bed.records.seed(GH_KEY, { localDirName: GH_KEY, entry: 'index.js', trusted: 'trusted' })
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    expect(review.exists).toBe(true)
    expect(review.overwrite).toBe(true)
    expect(review.existing?.key).toBe(key(GH_KEY))
  })

  it('refuses to review (and thus overwrite) protected entries', async () => {
    const bed = testbed()
    bed.records.seed(GH_KEY, { localDirName: GH_KEY })
    const source = ops(bed, { isProtectedKey: (value) => value === GH_KEY })
    await expect(source.previewInstall(SLUG)).rejects.toMatchObject({ code: 'market/protected' })
    expect(bed.engines.previewCalls).toHaveLength(0)
  })

  it('accepts a degraded preview (unreadable manifest) without blocking', async () => {
    const bed = testbed()
    bed.engines.previewResult = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'manifest unreadable',
      code: 'github/not-found',
    }
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    expect(review.preview.status).toBe('degraded')
    if (review.preview.status === 'degraded') expect(review.preview.code).toBe('github/not-found')
  })

  it('rejects a malformed repository slug with github/bad-request', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.previewInstall('not-a-slug')).rejects.toMatchObject({ code: 'github/bad-request' })
  })
})

describe('MarketSourceOperations install (double confirmation)', () => {
  it('requires a preview token, then runs the install with the derived key', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.install(SLUG, 'missing')).rejects.toMatchObject({ code: 'market/confirm-required' })

    const review = await source.previewInstall(SLUG)
    await expect(source.install(SLUG, 'wrong-token')).rejects.toMatchObject({ code: 'market/confirm-invalid' })

    const outcome = await source.install(SLUG, review.confirmToken)
    expect(outcome.key).toBe(key(GH_KEY))
    expect(outcome.overwritten).toBe(false)
    expect(outcome.record.enabled).toBe(false)
    expect(bed.engines.installCalls).toEqual([{
      repositoryRoot: '/repo',
      key: GH_KEY,
      repository: SLUG,
      version: null,
    }])
    expect(bed.engines.synced).toHaveLength(1)

    // Tokens are single-use.
    await expect(source.install(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'market/confirm-required',
    })
  })

  it('pins the reviewed version on the install', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG, 'v2.0.0')
    await source.install(SLUG, review.confirmToken, 'v2.0.0')
    expect(bed.engines.installCalls[0]?.version).toBe('v2.0.0')
  })

  it('rejects expired confirmations with market/confirm-expired', async () => {
    let nowMs = 5_000
    const bed = testbed()
    const source = ops(bed, { now: () => new Date(nowMs) })
    const review = await source.previewInstall(SLUG)
    nowMs += REMOVE_CONFIRM_TTL_MS + 1
    await expect(source.install(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'market/confirm-expired',
    })
  })

  it('overwrites an existing checkout and reports overwritten=true', async () => {
    const bed = testbed()
    bed.records.seed(GH_KEY, { localDirName: GH_KEY, entry: 'index.js' })
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    const outcome = await source.install(SLUG, review.confirmToken)
    expect(outcome.overwritten).toBe(true)
  })

  it('propagates pipeline failures with their stable install/* codes', async () => {
    const bed = testbed()
    bed.engines.installError = new MarketError('install/git-failed', 'clone failed', { path: '/repo' })
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    await expect(source.install(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'install/git-failed',
    })
  })
})