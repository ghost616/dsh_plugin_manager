import { describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import { pluginKeyForGithubRef } from '../src/host/market/keys.ts'
import { REMOVE_CONFIRM_TTL_MS } from '../src/host/control/controller.ts'
import {
  ANALYSIS_UNAVAILABLE_NOTE,
  DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
  DOWNLOAD_REASON_EXPIRED,
  DOWNLOAD_REASON_REPAIR_NO_RECORD,
  DOWNLOAD_REASON_REPAIR_RECORD_STALE,
  DOWNLOAD_REASON_UNKNOWN,
} from '../src/host/control/source.ts'
import type { DownloadCommit, MarketSourceOperations } from '../src/host/control/source.ts'
import { fakeAnalysisEngine, fakeDistribution, key, makeSourceOps, refDirName, testbed } from './support/control-testbed.ts'

/** Repository slug → derived key convention under test. */
const SLUG = 'octocat/demo-plugin'
const GH_KEY = 'gh-octocat-demo-plugin'

/**
 * Run the whole phased download of one reviewed ref: preview (the two-step
 * confirmation), prepare, classify, commit. `classify` overrides the
 * classification phase's answer; `commitAs` overrides what the caller passes to
 * the commit phase (they differ when the user corrects the model's label).
 */
async function download(
  source: MarketSourceOperations,
  repository: string = SLUG,
  options: {
    readonly refKind?: string | null
    readonly version?: string | null
    readonly classify?: string
    readonly commitAs?: string
  } = {},
): Promise<DownloadCommit> {
  const refKind = options.refKind ?? null
  const version = options.version ?? null
  const review = await source.previewInstall(repository, refKind, version)
  const prepared = await source.prepareDownload(repository, review.confirmToken, refKind, version)
  const classification = await source.classifyDownload(prepared.token)
  return await source.commitDownload(prepared.token, options.commitAs ?? classification.classification)
}

/** Preview outcome of an unconventional checkout (no readable manifest). */
const NO_MANIFEST_PREVIEW = {
  status: 'degraded' as const,
  summary: { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } },
  reason: 'no package.json on the probed branches',
  code: 'github/not-found' as const,
}

type Bed = ReturnType<typeof testbed>

/** One source over the shared fakes of a testbed. */
function ops(
  bed: Bed,
  options: {
    idle?: boolean
    now?: () => Date
    isProtectedKey?: (k: string) => boolean
    /** Download-stage TTL (from the successful prepare); default 10 min. */
    downloadTtlMs?: number
  } = {},
) {
  return makeSourceOps(
    options.idle === true ? null : bed.repository,
    bed.records,
    bed.engines,
    {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.downloadTtlMs === undefined ? {} : { downloadTtlMs: options.downloadTtlMs }),
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
    await expect(source.prepareDownload(SLUG, 'tok')).rejects.toMatchObject({ code: 'market/idle' })
    await expect(source.classifyDownload('dl-tok-1')).rejects.toMatchObject({ code: 'market/idle' })
    await expect(source.commitDownload('dl-tok-1', 'other')).rejects.toMatchObject({ code: 'market/idle' })
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
    // A transport hiccup is not a classification signal: the review keeps the
    // standard-plugin prediction and never consults the analyzer.
    expect(review.classification).toBe('plugin')
    expect(review.entryNote).toBeUndefined()
    expect(review.analysis).toBeUndefined()
  })

  it('falls back to the other classification (no engine) and still downloads the checkout', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    bed.engines.installedEntry = null
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    // No engine → conservative classification with a config hint, no refusal.
    expect(review.classification).toBe('other')
    expect(review.note).toEqual(ANALYSIS_UNAVAILABLE_NOTE)
    // The Host never ships user-facing prose: the client localizes note.kind.
    expect(review.entryNote).toBeUndefined()
    expect(review.buildRequired).toBeUndefined()
    expect(review.analysis).toBeUndefined()
    expect(review.confirmToken).toBeTruthy()

    // The two-step protocol still runs: the checkout is downloaded and filed
    // with the reviewed classification and no entry.
    const outcome = await download(source, SLUG)
    expect(bed.engines.installCalls[0]).toMatchObject({ key: GH_KEY })
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'commit')).toHaveLength(1)
    expect(outcome.record.classification).toBe('other')
    expect(outcome.record.entry).toBeNull()
    expect(outcome).toMatchObject({ classification: 'other', entry: null, dependenciesInstalled: false })
    expect(bed.engines.synced).toHaveLength(1)
  })

  it('files a skills checkout with the skills tag instead of refusing the install', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    bed.engines.installedEntry = null
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'skills', reason: 'A Claude skills collection' }),
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(analysis.calls.map(call => call.repository)).toEqual([SLUG])
    expect(review.classification).toBe('skills')
    // The staged classifier is the authority for the committed tag.
    bed.engines.classification = { ...bed.engines.classification, classification: 'skills', outcome: 'classified', unclassified: false, entryPresent: null, entryHint: null }
    expect(review.note).toEqual({ kind: 'classified', text: 'A Claude skills collection' })
    expect(review.entryNote).toBe('A Claude skills collection')
    expect(review.analysis).toEqual({ installable: false, kind: 'skills', reason: 'A Claude skills collection' })

    const outcome = await download(source, SLUG)
    expect(bed.engines.installCalls[0]).toMatchObject({ key: GH_KEY })
    expect(bed.engines.classifications).toContain('skills')
    expect(outcome.record).toMatchObject({ classification: 'skills', entry: null })
    expect(outcome).toMatchObject({ classification: 'skills', entry: null })
    expect(bed.engines.synced).toHaveLength(1)
  })

  it('lets the checkout entry probe win over the reviewed skills prediction', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    // The review predicted a skills pack, but the downloaded checkout really
    // carries a runnable entry: the host probe wins and the record stays
    // loadable — a prediction must never demote a real plugin.
    bed.engines.installedEntry = 'index.js'
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'skills', reason: 'the model guessed a skills pack' }),
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(review.classification).toBe('skills')

    // The staged classifier also guessed skills, but the checkout really carries
    // a runnable entry: the commit phase probes the checkout and files `plugin`.
    bed.engines.classification = { ...bed.engines.classification, classification: 'skills', entryPresent: true, entryHint: 'index.js' }
    const outcome = await download(source, SLUG)
    expect(bed.engines.classifications).toContain('skills')
    expect(outcome).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    expect(outcome.record).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    expect(bed.engines.synced[0]).toMatchObject({ classification: 'plugin', entry: 'index.js' })
  })

  it('classifies preset/tooling verdicts as other and still installs them', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    bed.engines.installedEntry = null
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'other', reason: 'an include-tree preset' }),
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(review.classification).toBe('other')
    expect(review.note).toEqual({ kind: 'classified', text: 'an include-tree preset' })
    expect(review.entryNote).toBe('an include-tree preset')
    expect(review.analysis).toEqual({ installable: false, kind: 'other', reason: 'an include-tree preset' })
    bed.engines.classification = { ...bed.engines.classification, classification: 'other', reason: 'an include-tree preset' }
    const outcome = await download(source, SLUG)
    expect(bed.engines.classifications).toContain('other')
    expect(outcome.record).toMatchObject({ classification: 'other', entry: null })
  })

  it('marks a plugin that still needs its build (buildRequired, entry-missing note)', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    bed.engines.installedEntry = null
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({
        classification: 'other',
        entry: null,
        entryHint: 'dist/index.js',
        reason: 'No runnable entry "dist/index.js" is present in the checkout yet; it needs a build step first.',
        buildRequired: true,
      }),
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(review.classification).toBe('other')
    expect(review.buildRequired).toBe(true)
    expect(review.note).toEqual({
      kind: 'entry-missing',
      text: 'No runnable entry "dist/index.js" is present in the checkout yet; it needs a build step first.',
      entry: 'dist/index.js',
    })
    expect(review.entryNote).toContain('build step first')
    // `entryNote` is DEBUG-ONLY diagnostics (engine detail); the copy channel
    // is the structured note above, and the persisted tag is `classification`.
    // A build-first plugin keeps a legacy verdict rendered as the folded `other`
    // kind; the fold into the persisted tag rides on the classification too.
    expect(review.analysis).toEqual({
      installable: false,
      kind: 'other',
      reason: expect.stringContaining('build step first'),
    })
    // The staged classifier reports the same build-first state.
    bed.engines.classification = {
      ...bed.engines.classification,
      classification: 'other',
      entryPresent: false,
      entryHint: 'dist/index.js',
    }
    const outcome = await download(source, SLUG)
    expect(bed.engines.classifications).toContain('other')
    expect(outcome.record).toMatchObject({ classification: 'other', entry: null })
  })

  it('[test-only seam] reports buildRequired from the preview-time entry probe when one is wired', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    // TEST-ONLY: `analysisEntryProbe` is a seam the production assembly never
    // wires (the remote preview cannot inspect a checkout), so `buildRequired`
    // is reachable only in specs — this case pins the fold the seam drives.
    const probed: string[] = []
    const analysis = fakeAnalysisEngine({
      probeDistribution: {
        classification: 'plugin',
        entryHint: 'dist/index.js',
        reason: 'a Cordis plugin that needs a build first',
      },
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      analysis,
      analysisEntryProbe: (repository, entry) => {
        probed.push(`${repository}:${entry}`)
        return false
      },
    })
    const review = await source.previewInstall(SLUG)
    expect(probed).toEqual([`${SLUG}:dist/index.js`])
    expect(analysis.calls[0]).toMatchObject({ probed: true, probedEntries: ['dist/index.js'] })
    expect(review).toMatchObject({ classification: 'other', buildRequired: true })
    expect(review.note).toMatchObject({ kind: 'entry-missing', entry: 'dist/index.js' })
  })

  it('[test-only seam] answers plugin from the same probe when the entry is present', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    const analysis = fakeAnalysisEngine({
      probeDistribution: { classification: 'plugin', entryHint: 'index.js', reason: 'a Cordis plugin' },
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, {
      analysis,
      analysisEntryProbe: () => true,
    })
    const review = await source.previewInstall(SLUG)
    expect(review).toMatchObject({ classification: 'plugin' })
    expect(review.buildRequired).toBeUndefined()
    expect(review.note).toBeUndefined()
  })

  it('lets an analysis verdict of a runnable plugin through as a plugin review', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'plugin', entry: 'index.js', entryHint: 'index.js', reason: 'a Cordis plugin' }),
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(analysis.calls.map(call => call.repository)).toEqual([SLUG])
    expect(review.classification).toBe('plugin')
    expect(review.entryNote).toBeUndefined()
    expect(review.note).toBeUndefined()
    expect(review.analysis).toBeUndefined()
    bed.engines.classification = { ...bed.engines.classification, classification: 'plugin', entryPresent: true, entryHint: 'index.js' }
    const outcome = await download(source, SLUG)
    expect(bed.engines.classifications).toContain('plugin')
    expect(outcome.record.classification).toBe('plugin')
    expect(outcome.key).toBe(key(GH_KEY))
  })

  it('treats a null analyzer answer as a standard plugin review', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    const analysis = fakeAnalysisEngine({ result: null })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(analysis.calls.map(call => call.repository)).toEqual([SLUG])
    expect(review.classification).toBe('plugin')
    expect(review.entryNote).toBeUndefined()
    const outcome = await download(source, SLUG)
    expect(outcome.key).toBe(key(GH_KEY))
  })

  it('bypasses analysis entirely for standard npm plugins (ready preview)', async () => {
    const bed = testbed()
    const analysis = fakeAnalysisEngine({
      result: fakeDistribution({ classification: 'other', reason: 'should not run' }),
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(review.preview.status).toBe('ready')
    expect(review.classification).toBe('plugin')
    expect(review.analysis).toBeUndefined()
    expect(analysis.calls).toHaveLength(0)
  })

  it('falls back to other (never blocking) when the analysis engine fails', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    bed.engines.installedEntry = null
    // LLM jitter takes many shapes: unparsable output, transport errors and
    // plain engine bugs all degrade to the conservative classification — the
    // review always mints its token, so the checkout can still be downloaded.
    const failures: unknown[] = [
      new MarketError('market/llm-bad-output', 'the model returned prose, not JSON'),
      new MarketError('market/llm-failed', 'model exploded'),
      new MarketError('github/network', 'offline', { path: 'https://api.github.com' }),
      new Error('boom: analysis engine crashed'),
    ]
    for (const failure of failures) {
      const analysis = fakeAnalysisEngine({ error: failure })
      const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
      const review = await source.previewInstall(SLUG)
      expect(review.classification).toBe('other')
      expect(review.note).toEqual(ANALYSIS_UNAVAILABLE_NOTE)
      expect(review.entryNote).toBeUndefined()
      expect(review.analysis).toBeUndefined()
      await expect(download(source, SLUG, { commitAs: 'other' })).resolves.toMatchObject({ key: key(GH_KEY) })
    }
    expect(bed.engines.installCalls).toHaveLength(failures.length)
    // Every download still filed the conservative tag the review fell back to.
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'commit')).toHaveLength(failures.length)
    expect((await bed.records.list()).every(record => record.classification !== 'plugin')).toBe(true)
  })

  it('degrades an engine market/llm-unconfigured to the other classification as well', async () => {
    const bed = testbed()
    bed.engines.previewResult = NO_MANIFEST_PREVIEW
    const analysis = fakeAnalysisEngine({
      error: new MarketError('market/llm-unconfigured', 'no provider configured'),
    })
    const source = makeSourceOps(bed.repository, bed.records, bed.engines, { analysis })
    const review = await source.previewInstall(SLUG)
    expect(review.classification).toBe('other')
    expect(review.note).toEqual(ANALYSIS_UNAVAILABLE_NOTE)
    expect(bed.engines.previewCalls).toEqual([SLUG])
  })

  it('rejects a malformed repository slug with github/bad-request', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.previewInstall('not-a-slug')).rejects.toMatchObject({ code: 'github/bad-request' })
  })
})

describe('MarketSourceOperations download channel (phased, double confirmation)', () => {
  it('requires a review token, then prepares with the derived key', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.prepareDownload(SLUG, 'missing')).rejects.toMatchObject({ code: 'market/confirm-required' })

    const review = await source.previewInstall(SLUG)
    await expect(source.prepareDownload(SLUG, 'wrong-token')).rejects.toMatchObject({ code: 'market/confirm-invalid' })

    const prepared = await source.prepareDownload(SLUG, review.confirmToken)
    expect(prepared.key).toBe(key(GH_KEY))
    expect(prepared.state).toBe('prepared')
    expect(prepared.token).toMatch(/^dl-/)
    expect(bed.engines.installCalls).toEqual([{
      repositoryRoot: '/repo',
      key: GH_KEY,
      repository: SLUG,
      version: null,
      // No refKind on a legacy (default-branch) download.
      refKind: undefined,
    }])

    const classification = await source.classifyDownload(prepared.token)
    expect(classification).toMatchObject({ outcome: 'classified', classification: 'plugin' })
    const outcome = await source.commitDownload(prepared.token, classification.classification)
    expect(outcome.key).toBe(key(GH_KEY))
    expect(outcome.overwritten).toBe(false)
    expect(outcome.record.enabled).toBe(false)
    // The download path never installs dependencies.
    expect(outcome.dependenciesInstalled).toBe(false)
    expect(bed.engines.synced).toHaveLength(1)

    // The review token is single use: preparing again needs a new review.
    await expect(source.prepareDownload(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'market/confirm-required',
    })
    // The download handle is consumed by the commit.
    await expect(source.commitDownload(prepared.token, 'plugin')).rejects.toMatchObject({
      code: 'record/not-found',
    })
  })

  it('walks the three phases and reports each phase error code', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)

    // Phase 1 failure: the clone fails (stable install/* code, no handle).
    bed.engines.installError = new MarketError('install/git-failed', 'clone failed', { path: '/repo' })
    await expect(source.prepareDownload(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'install/git-failed',
    })
    bed.engines.installError = undefined

    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    // Phase 2 never throws for a model problem: the answer carries the reason.
    bed.engines.classification = {
      outcome: 'failed',
      classification: 'other',
      reason: 'the model call failed',
      unclassified: true,
      entryPresent: null,
      entryHint: null,
      errorCode: 'market/llm-failed',
    }
    const classification = await source.classifyDownload(prepared.token)
    expect(classification).toMatchObject({
      outcome: 'failed',
      classification: 'other',
      unclassified: true,
      errorCode: 'market/llm-failed',
    })

    // Phase 3 failure: an unexpected commit failure surfaces as install/io.
    bed.engines.commitError = new MarketError('install/io', 'swap failed', { path: '/repo' })
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      code: 'install/io',
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })
    // The host dropped ITS handle, but the caller's handle stays usable: the next
    // phase re-stages from the recipe (a fresh clone) and answers normally.
    bed.engines.commitError = undefined
    await expect(source.classifyDownload(prepared.token)).resolves.toMatchObject({ outcome: 'failed' })
    // The successful prepare plus the re-staging one (the failed clone never
    // registered a handle).
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(2)
  })

  it('rejects an unknown download handle on classify/commit without touching the store', async () => {
    const bed = testbed()
    const source = ops(bed)
    await expect(source.classifyDownload('dl-nope-1')).rejects.toMatchObject({ code: 'record/not-found' })
    await expect(source.commitDownload('dl-nope-1', 'other')).rejects.toMatchObject({ code: 'record/not-found' })
    expect(bed.engines.stagedCalls).toHaveLength(0)
    expect(await bed.records.list()).toEqual([])
  })

  it('validates the committed classification with market/bad-request (staged handle survives)', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    const error = await source.commitDownload(prepared.token, 'preset').catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'market/bad-request' })
    // Nothing was filed and the handle is still usable with a valid label.
    expect(await bed.records.list()).toEqual([])
    const outcome = await source.commitDownload(prepared.token, 'other')
    expect(outcome.record.classification).toBe('plugin')
  })

  it('cancels a staged download and cleans the staging (idempotent)', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    await expect(source.cancelDownload(prepared.token)).resolves.toBe(true)
    // The fake engine records the cancel and drops the handle.
    expect(bed.engines.cancelledCalls).toEqual([prepared.token])
    // Idempotent: a second cancel (and an unknown token) resolve false.
    await expect(source.cancelDownload(prepared.token)).resolves.toBe(false)
    await expect(source.cancelDownload('dl-nope-2')).resolves.toBe(false)
    // The cancelled handle can no longer be classified or committed.
    await expect(source.classifyDownload(prepared.token)).rejects.toMatchObject({ code: 'record/not-found' })
    expect(await bed.records.list()).toEqual([])
  })

  it('keeps a staged download alive after its review window (independent download TTL)', async () => {
    let nowMs = 1_000
    const bed = testbed()
    // Review window: 30s. Download window: 10 minutes — the review window is
    // spent by prepare and must have no say over a download in progress.
    const source = ops(bed, { now: () => new Date(nowMs), downloadTtlMs: 600_000 })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)
    expect(bed.engines.cancelledCalls).toEqual([])

    // Well past the review window, still inside the download window: a new
    // review sweeps the (spent) review bookkeeping but NOT the live download.
    nowMs += REMOVE_CONFIRM_TTL_MS + 1
    await source.previewInstall(SLUG)
    expect(bed.engines.cancelledCalls).toEqual([])

    // The download itself is still fully usable.
    const classification = await source.classifyDownload(prepared.token)
    expect(classification).toMatchObject({ outcome: 'classified', classification: 'plugin' })
    const outcome = await source.commitDownload(prepared.token, classification.classification)
    expect(outcome.key).toBe(key(GH_KEY))
    expect(outcome.dependenciesInstalled).toBe(false)
  })

  it('sweeps a download only when its own deadline passes, and says so', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = ops(bed, { now: () => new Date(nowMs), downloadTtlMs: 60_000 })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    // Inside the download window: nothing is swept.
    nowMs += 30_000
    await expect(source.classifyDownload(prepared.token)).resolves.toBeDefined()
    expect(bed.engines.cancelledCalls).toEqual([])

    // Past the download window the staging is cleaned up and the failure says
    // "expired" (not "never prepared"), so the UI can explain the cleanup.
    nowMs += 60_000
    const error = await source.classifyDownload(prepared.token).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED, path: prepared.token },
    })
    expect(bed.engines.cancelledCalls).toEqual([prepared.token])
    expect((error as Error).message).toContain('cleaned up')
    // The same handle keeps reporting the expired (not the unknown) reason.
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
  })

  it('distinguishes a never-prepared handle from an expired one', async () => {
    const bed = testbed()
    const source = ops(bed)
    const error = await source.classifyDownload('dl-0123456789abcdef0123456789abcdef').catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_UNKNOWN },
    })
    expect((error as Error).message).toContain('unknown')
    expect(bed.engines.cancelledCalls).toEqual([])
  })

  it('keeps a pre-swap commit failure retryable: the same token commits after a re-stage', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    // The host fails before the swap (nothing moved, its handle is dropped).
    bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
    const failure = await source.commitDownload(prepared.token, 'other').catch((e: unknown) => e)
    expect(failure).toMatchObject({
      code: 'install/io',
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP, key: GH_KEY },
    })
    expect((failure as Error).message).toContain('Retry the commit with the same download handle')

    // Retry with the SAME token: control re-stages from the recipe first.
    bed.engines.commitError = undefined
    const outcome = await source.commitDownload(prepared.token, 'other')
    expect(outcome.key).toBe(key(GH_KEY))
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(2)
    expect(bed.engines.classifications).toEqual(['other', 'other'])

    // A handle is consumable once: the successful retry retires BOTH the
    // re-staged handle and the original token, so repeating the commit cannot
    // clone the repository a third time.
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(2)
  })

  it('classifies a handle left retryable by a pre-swap failure by re-staging it once', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(1)

    // The caller handle stays usable for EVERY phase: classify re-stages from
    // the recipe (the host dropped its own handle when the commit failed) and
    // answers normally instead of failing on a dead handle.
    bed.engines.commitError = undefined
    const classification = await source.classifyDownload(prepared.token)
    expect(classification.outcome).toBe('classified')
    const prepares = bed.engines.stagedCalls.filter(call => call.kind === 'prepare')
    expect(prepares).toHaveLength(2)
    // ...and it classified the RE-STAGED host handle, not the caller's token.
    const classified = bed.engines.stagedCalls.find(call => call.kind === 'classify')
    expect(classified?.token).toBe(prepares[1]?.token)
    expect(classified?.token).not.toBe(prepared.token)

    // The follow-up commit reuses that adopted staging: no third clone.
    const outcome = await source.commitDownload(prepared.token, classification.classification)
    expect(outcome.key).toBe(key(GH_KEY))
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(2)
  })

  it('cancels the re-staged host handle, not the caller token', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })
    bed.engines.commitError = undefined
    await source.classifyDownload(prepared.token)
    const restaged = bed.engines.stagedCalls.filter(call => call.kind === 'prepare')[1]?.token
    expect(restaged).toBeDefined()

    await expect(source.cancelDownload(prepared.token)).resolves.toBe(true)
    expect(bed.engines.cancelledCalls).toEqual([restaged])
    // Consumed for good: the caller token cannot be used again.
    await expect(source.cancelDownload(prepared.token)).resolves.toBe(false)
    await expect(source.classifyDownload(prepared.token)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
  })

  it('retires and cancels the re-staged host handle when the window expires lazily', async () => {
    let nowMs = 1_000
    const bed = testbed()
    const source = ops(bed, { now: () => new Date(nowMs), downloadTtlMs: 60_000 })
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
    await expect(source.commitDownload(prepared.token, 'other')).rejects.toMatchObject({
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP },
    })
    bed.engines.commitError = undefined
    await source.classifyDownload(prepared.token)
    const restaged = bed.engines.stagedCalls.filter(call => call.kind === 'prepare')[1]?.token
    expect(restaged).toBeDefined()

    // No review happens here, so the phase call discovers the expiry itself — and
    // it must clean up the staging the host actually holds (the re-staged one),
    // not the caller token the host already dropped.
    nowMs += 60_000
    await expect(source.classifyDownload(prepared.token)).rejects.toMatchObject({
      code: 'record/not-found',
      details: { reason: DOWNLOAD_REASON_EXPIRED },
    })
    expect(bed.engines.cancelledCalls).toEqual([restaged])
  })

  it('splits the pre-swap window by the host previousRemoved fact and points at the missing checkout', async () => {
    const bed = testbed()
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    const prepared = await source.prepareDownload(SLUG, review.confirmToken)

    // Sub-window 1 (previousRemoved === false): nothing was lost.
    bed.engines.commitError = new MarketError('install/io', 'the records file is locked')
    const harmless = await source.commitDownload(prepared.token, 'other').catch((e: unknown) => e)
    expect(harmless).toMatchObject({
      code: 'install/io',
      details: { reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP, key: GH_KEY },
    })
    expect((harmless as { details?: Record<string, unknown> }).details?.path).toBeUndefined()
    expect((harmless as Error).message).toContain('are unchanged')

    // Sub-window 2 (previousRemoved === true): the old checkout is gone.
    bed.engines.commitRemovedPrevious = true
    const lost = await source.commitDownload(prepared.token, 'other').catch((e: unknown) => e)
    expect(lost).toMatchObject({
      code: 'install/io',
      details: {
        reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
        key: GH_KEY,
        path: `/repo/${GH_KEY}`,
      },
    })
    expect((lost as Error).message).toContain('ALREADY been deleted')
    expect((lost as Error).message).not.toContain('are unchanged')

    // Both sub-windows stay retryable with the same handle.
    bed.engines.commitError = undefined
    bed.engines.commitRemovedPrevious = false
    await expect(source.commitDownload(prepared.token, 'other')).resolves.toMatchObject({ key: key(GH_KEY) })
    // One clone per failed attempt that got as far as the commit, plus the retry.
    expect(bed.engines.stagedCalls.filter(call => call.kind === 'prepare')).toHaveLength(3)
  })

  it('routes a post-swap failure to repair and names the two forms apart', async () => {
    // Form 1: no record existed — the fresh checkout has to be removed by hand.
    const fresh = testbed()
    const freshSource = ops(fresh)
    const freshReview = await freshSource.previewInstall(SLUG)
    const freshPrepared = await freshSource.prepareDownload(SLUG, freshReview.confirmToken)
    fresh.engines.commitError = new MarketError('install/io', 'the records file is locked')
    fresh.engines.commitFailsAfterSwap = true
    const noRecord = await freshSource.commitDownload(freshPrepared.token, 'other').catch((e: unknown) => e)
    expect(noRecord).toMatchObject({
      code: 'install/io',
      details: {
        reason: DOWNLOAD_REASON_REPAIR_NO_RECORD,
        key: GH_KEY,
        path: `/repo/${GH_KEY}`,
      },
    })
    expect((noRecord as Error).message).toContain('removed by hand')
    // The handle is consumed by the failed commit.
    await expect(freshSource.commitDownload(freshPrepared.token, 'other')).rejects.toMatchObject({
      code: 'record/not-found',
    })

    // Form 2: the previous record is still in place — the download can be rerun.
    const existing = testbed()
    existing.records.seed(GH_KEY, { localDirName: GH_KEY, entry: 'index.js', classification: 'plugin' })
    const existingSource = ops(existing)
    const existingReview = await existingSource.previewInstall(SLUG)
    const existingPrepared = await existingSource.prepareDownload(SLUG, existingReview.confirmToken)
    existing.engines.commitError = new MarketError('install/io', 'the records file is locked')
    existing.engines.commitFailsAfterSwap = true
    const stale = await existingSource.commitDownload(existingPrepared.token, 'other').catch((e: unknown) => e)
    expect(stale).toMatchObject({
      code: 'install/io',
      details: { reason: DOWNLOAD_REASON_REPAIR_RECORD_STALE, key: GH_KEY },
    })
    expect((stale as Error).message).toContain('run the download again')
    // The previous record is untouched, so a rerun is an idempotent overwrite.
    expect((await existing.records.get(key(GH_KEY)))?.classification).toBe('plugin')
  })

  it('drops an unconsumed review when its confirmation window passes', async () => {
    let nowMs = 1_000
    const bed = testbed()
    // No download TTL given: the default (10 min) applies, so the review window
    // is the governing deadline only for entries that never reached prepare.
    const source = ops(bed, { now: () => new Date(nowMs) })
    const review = await source.previewInstall(SLUG)

    // A new review of the same key replaces the confirmation: the stale token is
    // no longer the key's review, so it is refused as invalid (not "required").
    nowMs += REMOVE_CONFIRM_TTL_MS + 1
    await source.previewInstall(SLUG)
    await expect(source.prepareDownload(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'market/confirm-invalid',
    })

    // With no review at all for the ref, the refusal is the "required" one.
    await expect(source.prepareDownload('other/repo', 'tok')).rejects.toMatchObject({
      code: 'market/confirm-required',
    })
    expect(bed.engines.cancelledCalls).toEqual([])
  })

  it('pins the reviewed version on a legacy (no refKind) download', async () => {
    const bed = testbed()
    const source = ops(bed)
    await download(source, SLUG, { version: 'v2.0.0' })
    expect(bed.engines.installCalls[0]?.version).toBe('v2.0.0')
    expect(bed.engines.installCalls[0]?.refKind).toBeUndefined()
  })

  it('rejects expired confirmations with market/confirm-expired', async () => {
    let nowMs = 5_000
    const bed = testbed()
    const source = ops(bed, { now: () => new Date(nowMs) })
    const review = await source.previewInstall(SLUG)
    nowMs += REMOVE_CONFIRM_TTL_MS + 1
    await expect(source.prepareDownload(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'market/confirm-expired',
    })
  })

  it('overwrites an existing checkout and reports overwritten=true', async () => {
    const bed = testbed()
    bed.records.seed(GH_KEY, { localDirName: GH_KEY, entry: 'index.js' })
    const source = ops(bed)
    const outcome = await download(source, SLUG)
    expect(outcome.overwritten).toBe(true)
  })

  it('passes prepare failures through with their stable install/* codes', async () => {
    const bed = testbed()
    bed.engines.installError = new MarketError('install/git-failed', 'clone failed', { path: '/repo' })
    const source = ops(bed)
    const review = await source.previewInstall(SLUG)
    await expect(source.prepareDownload(SLUG, review.confirmToken)).rejects.toMatchObject({
      code: 'install/git-failed',
    })
  })

  it('never installs dependencies on the download path (no pnpm, dependenciesInstalled false)', async () => {
    const bed = testbed()
    const source = ops(bed)
    const outcome = await download(source, SLUG)
    expect(outcome.dependenciesInstalled).toBe(false)
    // The fake engine's prepare/classify/commit ran; the dependency command is
    // not part of this port at all (the host moved it to a standalone action).
    expect(bed.engines.stagedCalls.map(call => call.kind)).toEqual(['prepare', 'classify', 'commit'])
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

    const outcome = await download(source, SLUG, { refKind: 'branch', version: 'dev' })
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
    const branchOutcome = await download(source, SLUG, { refKind: 'branch', version: 'v1.2.3' })

    // The same-name tag is an independent plugin: no exists/overwrite flags
    // against the downloaded branch, and its confirmation is bound to its own
    // tuple — the tag's token cannot prepare the branch.
    const tagReview = await source.previewInstall(SLUG, 'tag', 'v1.2.3')
    expect(tagReview.key).toBe(tagKey)
    expect(tagReview.exists).toBe(false)
    expect(tagReview.overwrite).toBe(false)
    await expect(source.prepareDownload(SLUG, tagReview.confirmToken, 'branch', 'v1.2.3'))
      .rejects.toMatchObject({ code: 'market/confirm-required' })
    const tagOutcome = await download(source, SLUG, { refKind: 'tag', version: 'v1.2.3' })

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
    await expect(source.prepareDownload(SLUG, 'tok', 'release', 'v1')).rejects.toMatchObject({ code: 'market/bad-request' })
    expect(bed.engines.previewCalls).toHaveLength(0)
    expect(bed.engines.installCalls).toHaveLength(0)
  })
})