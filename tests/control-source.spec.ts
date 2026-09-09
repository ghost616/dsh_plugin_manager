import { describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import { pluginKeyForGithubRef } from '../src/host/market/keys.ts'
import { REMOVE_CONFIRM_TTL_MS } from '../src/host/control/controller.ts'
import { fakeAnalysisEngine, key, makeSourceOps, refDirName, testbed } from './support/control-testbed.ts'

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
    await expect(source.repositoryDetail(SLUG)).rejects.toMatchObject({ code: 'market/idle' })
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

describe('MarketSourceOperations repositoryDetail', () => {
  it('aggregates metadata, branches, tags and README of one repository', async () => {
    const bed = testbed()
    const source = ops(bed)
    const detail = await source.repositoryDetail(SLUG)
    expect(detail).toEqual({
      repository: SLUG,
      name: 'demo-plugin',
      description: 'a dsh plugin',
      stars: 12,
      updatedAt: '2026-01-01T00:00:00.000Z',
      url: 'https://github.com/octocat/demo-plugin',
      cloneUrl: 'https://github.com/octocat/demo-plugin.git',
      defaultBranch: 'main',
      branches: ['main'],
      tags: ['v1.0.0'],
      readme: '# demo plugin\n',
    })
    expect(bed.engines.detailCalls).toEqual([
      { kind: 'meta', slug: SLUG },
      { kind: 'branches', slug: SLUG },
      { kind: 'tags', slug: SLUG },
      { kind: 'readme', slug: SLUG },
    ])
  })

  it('tolerates a missing README (GitHub 404) and yields readme null', async () => {
    const bed = testbed()
    bed.engines.readmeError = new MarketError('github/not-found', 'no README', {
      path: 'https://api.github.com/repos/octocat/demo-plugin/readme',
    })
    const source = ops(bed)
    const detail = await source.repositoryDetail(SLUG)
    expect(detail.readme).toBeNull()
    expect(detail.branches).toEqual(['main'])
    expect(detail.defaultBranch).toBe('main')
  })

  it('propagates a non-404 readme failure instead of swallowing it', async () => {
    const bed = testbed()
    bed.engines.readmeError = new MarketError('github/rate-limit', 'limited', { path: 'https://api.github.com' })
    const source = ops(bed)
    await expect(source.repositoryDetail(SLUG)).rejects.toMatchObject({ code: 'github/rate-limit' })
  })

  it('fails the whole aggregation when a non-readme query fails', async () => {
    const bed = testbed()
    bed.engines.branchesError = new MarketError('github/network', 'offline', { path: 'https://api.github.com' })
    const source = ops(bed)
    await expect(source.repositoryDetail(SLUG)).rejects.toMatchObject({ code: 'github/network' })
  })

  it('rejects a malformed repository slug with github/bad-request before any engine call', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.repositoryDetail('not-a-slug')).rejects.toMatchObject({ code: 'github/bad-request' })
    expect(bed.engines.detailCalls).toHaveLength(0)
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

  it('keeps a transport-degraded preview (network hiccup) installable without analysis', async () => {
    const bed = testbed()
    bed.engines.previewResult = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'manifest temporarily unreadable',
      code: 'github/network',
    }
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    expect(review.preview.status).toBe('degraded')
    if (review.preview.status === 'degraded') expect(review.preview.code).toBe('github/network')
    expect(review.analysis).toBeUndefined()
  })

  it('refuses an unconventional (no manifest) candidate with market/llm-unconfigured when no analysis engine is wired', async () => {
    const bed = testbed()
    bed.engines.previewResult = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const source = ops(bed)
    await expect(source.previewInstall(SLUG)).rejects.toMatchObject({ code: 'market/llm-unconfigured' })
    expect(bed.engines.previewCalls).toEqual([SLUG])
  })

  it('runs analysis on an unconventional candidate and carries a refusal on the review', async () => {
    const bed = testbed()
    bed.engines.previewResult = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({ result: { installable: false, kind: 'skills', reason: 'A Claude skills collection' } })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(analysis.calls).toEqual([SLUG])
    expect(review.analysis).toEqual({ installable: false, kind: 'skills', reason: 'A Claude skills collection' })
    // install() of the refused review rejects up front (no installer/record).
    await expect(source.install(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'market/unsupported-skills',
      message: 'A Claude skills collection',
    })
    expect(bed.engines.installCalls).toHaveLength(0)
    expect(bed.engines.synced).toHaveLength(0)
  })

  it('lets an analysis verdict of a runnable plugin through without a refusal', async () => {
    const bed = testbed()
    bed.engines.previewResult = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({ result: null })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(analysis.calls).toEqual([SLUG])
    expect(review.analysis).toBeUndefined()
    const outcome = await source.install(SLUG, review.confirmToken)
    expect(outcome.key).toBe(key(GH_KEY))
  })

  it('bypasses analysis entirely for standard npm plugins (ready preview)', async () => {
    const bed = testbed()
    const analysis = fakeAnalysisEngine({ result: { installable: false, kind: 'other', reason: 'should not run' } })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(review.preview.status).toBe('ready')
    expect(review.analysis).toBeUndefined()
    expect(analysis.calls).toHaveLength(0)
  })

  it('propagates analysis engine failures with their stable llm codes', async () => {
    const bed = testbed()
    bed.engines.previewResult = {
      status: 'degraded',
      summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
      reason: 'no package.json on the probed branches',
      code: 'github/not-found',
    }
    const analysis = fakeAnalysisEngine({ error: new MarketError('market/llm-failed', 'model exploded') })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    await expect(source.previewInstall(SLUG)).rejects.toMatchObject({ code: 'market/llm-failed' })
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

  it('pins the reviewed version on a legacy (no refKind) install', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG, null, 'v2.0.0')
    await source.install(SLUG, review.confirmToken, null, 'v2.0.0')
    expect(bed.engines.installCalls[0]?.version).toBe('v2.0.0')
    expect(bed.engines.installCalls[0]?.refKind).toBeUndefined()
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

describe('MarketSourceOperations v2 refs (refKind)', () => {
  it('reviews a branch ref under its per-tuple key and carries refKind in the review', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG, 'branch', 'dev')
    expect(review.refKind).toBe('branch')
    expect(review.key).toBe(pluginKeyForGithubRef(SLUG, 'branch', 'dev'))
    expect(review.exists).toBe(false)
    expect(review.overwrite).toBe(false)
    expect(bed.engines.previewCalls).toEqual([SLUG])

    const outcome = await source.install(SLUG, review.confirmToken, 'branch', 'dev')
    expect(outcome.key).toBe(pluginKeyForGithubRef(SLUG, 'branch', 'dev'))
    expect(bed.engines.installCalls[0]).toMatchObject({
      repositoryRoot: '/repo',
      key: pluginKeyForGithubRef(SLUG, 'branch', 'dev'),
      repository: SLUG,
      refKind: 'branch',
      version: 'dev',
    })
    expect((outcome.record.source as { refKind?: string }).refKind).toBe('branch')
    expect(outcome.record.localDirName).toBe(refDirName(SLUG, 'branch', 'dev'))
  })

  it('installs same-name branch and tag separately with unique keys and dirs', async () => {
    const bed = testbed()
    const source = ops(bed)
    const branchKey = pluginKeyForGithubRef(SLUG, 'branch', 'v1.2.3')
    const tagKey = pluginKeyForGithubRef(SLUG, 'tag', 'v1.2.3')
    expect(branchKey).not.toBe(tagKey)
    expect(refDirName(SLUG, 'branch', 'v1.2.3')).not.toBe(refDirName(SLUG, 'tag', 'v1.2.3'))

    const branchReview = await source.previewInstall(SLUG, 'branch', 'v1.2.3')
    expect(branchReview.key).toBe(branchKey)
    const branchOutcome = await source.install(SLUG, branchReview.confirmToken, 'branch', 'v1.2.3')

    // The same-name tag is an independent plugin: no exists/overwrite flags
    // against the installed branch, and its token is its own.
    const tagReview = await source.previewInstall(SLUG, 'tag', 'v1.2.3')
    expect(tagReview.key).toBe(tagKey)
    expect(tagReview.exists).toBe(false)
    expect(tagReview.overwrite).toBe(false)
    await expect(source.install(SLUG, tagReview.confirmToken, 'branch', 'v1.2.3'))
      .rejects.toMatchObject({ code: 'market/confirm-required' })
    const tagOutcome = await source.install(SLUG, tagReview.confirmToken, 'tag', 'v1.2.3')

    expect(branchOutcome.key).not.toBe(tagOutcome.key)
    expect(await bed.records.get(branchKey)).not.toBeNull()
    expect(await bed.records.get(tagKey)).not.toBeNull()
    expect(bed.engines.installCalls.map(call => call.key)).toEqual([branchKey, tagKey])
    expect(bed.engines.installCalls.map(call => call.refKind)).toEqual(['branch', 'tag'])
  })

  it('reports an already-installed tuple as an overwrite update only for that tuple', async () => {
    const bed = testbed()
    bed.records.seed(pluginKeyForGithubRef(SLUG, 'tag', 'v1.2.3'), {
      localDirName: refDirName(SLUG, 'tag', 'v1.2.3') ?? GH_KEY,
    })
    const source = ops(bed)
    const tagReview = await source.previewInstall(SLUG, 'tag', 'v1.2.3')
    expect(tagReview.exists).toBe(true)
    expect(tagReview.overwrite).toBe(true)
    const branchReview = await source.previewInstall(SLUG, 'branch', 'v1.2.3')
    expect(branchReview.exists).toBe(false)
    expect(branchReview.overwrite).toBe(false)
  })

  it('refuses a v2 install without its ref name (market/bad-request, no engine call)', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.previewInstall(SLUG, 'tag')).rejects.toMatchObject({ code: 'market/bad-request' })
    await expect(source.previewInstall(SLUG, 'branch', null)).rejects.toMatchObject({ code: 'market/bad-request' })
    expect(bed.engines.previewCalls).toHaveLength(0)
  })

  it('refuses an unknown refKind with market/bad-request', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.previewInstall(SLUG, 'release')).rejects.toMatchObject({ code: 'market/bad-request' })
    await expect(source.install(SLUG, 'tok', 'release', 'v1')).rejects.toMatchObject({ code: 'market/bad-request' })
    expect(bed.engines.previewCalls).toHaveLength(0)
    expect(bed.engines.installCalls).toHaveLength(0)
  })
})