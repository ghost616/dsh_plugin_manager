/**
 * Three-phase download pipeline (prepare → classify → commit) + the manual
 * classification correction.
 *
 * The download path must never run a package manager: every case here records
 * the subprocess calls and asserts `pnpm` is absent, so a regression that puts
 * the dependency step back into the download is caught immediately.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PluginMarketKey } from '../src/types.ts'
import { MarketError } from '../src/host/market/errors.ts'
import {
  PluginInstaller,
  installCheckoutDependencies,
  isDownloadToken,
  type CommandOutcome,
  type CommandRunner,
  type DownloadCompletion,
  type DownloadToken,
  type PrepareDownloadInput,
} from '../src/host/market/index.ts'
import { parsePluginKey } from '../src/host/market/keys.ts'
import { repositoryRecordsPath } from '../src/host/market/layout.ts'
import { PluginRecordStore } from '../src/host/market/records.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

function key(value: string): PluginMarketKey {
  return parsePluginKey(value)
}

interface Fixture {
  /** package.json body; `null` writes no manifest at all. */
  manifest?: Record<string, unknown> | null
  /** Raw package.json text (overrides `manifest`). */
  rawManifest?: string
  files?: readonly string[]
  /** git clone exit code (non-zero simulates a clone failure). */
  cloneCode?: number
  cloneStderr?: string
  sha?: string
}

interface RunnerCall {
  command: string
  args: string[]
  cwd?: string
}

/** Fake git runner; `pnpm` is recorded and returns 0 (it must never be called). */
function runner(fixture: Fixture = {}): { run: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) })
    const all = [...args]
    if (command === 'git' && all[0] === 'clone') {
      if (fixture.cloneCode !== undefined && fixture.cloneCode !== 0) {
        return { code: fixture.cloneCode, stdout: '', stderr: fixture.cloneStderr ?? 'clone failed' }
      }
      const target = all[all.length - 1] ?? ''
      await mkdir(target, { recursive: true })
      await mkdir(join(target, '.git'))
      if (fixture.manifest !== null) {
        await writeFile(
          join(target, 'package.json'),
          fixture.rawManifest ?? JSON.stringify(fixture.manifest ?? {}),
          'utf8',
        )
      }
      for (const file of fixture.files ?? []) {
        const segments = file.split('/')
        const name = segments.pop() ?? file
        await mkdir(join(target, ...segments), { recursive: true })
        await writeFile(join(target, ...segments, name), '// fixture\n', 'utf8')
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && all.includes('rev-parse')) {
      return { code: 0, stdout: fixture.sha ?? 'a'.repeat(40), stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

function pnpmCalls(calls: readonly RunnerCall[]): RunnerCall[] {
  return calls.filter((call) => call.command === 'pnpm')
}

/** A completion backend returning one fixed analyzer JSON answer. */
function completionOf(answer: Record<string, unknown>): DownloadCompletion {
  return async () => JSON.stringify(answer)
}

/** Model kind → expected classification table (module-level: `it.each` lines must be one-line). */
const KIND_CASES = [
  [{ kind: 'plugin', reason: 'a Cordis plugin', entryHint: 'index.js' }, 'plugin'],
  [{ kind: 'skills', reason: 'a skills pack', entryHint: null }, 'skills'],
  [{ kind: 'preset', reason: 'a preset', entryHint: null }, 'other'],
  [{ kind: 'tooling', reason: 'a CLI', entryHint: null }, 'other'],
  [{ kind: 'other', reason: 'docs only', entryHint: null }, 'other'],
] as const satisfies readonly (readonly [Record<string, unknown>, 'plugin' | 'skills' | 'other'])[]

const prepareBase = {
  ownerRepo: 'owner/sample-plugin',
  key: key('gh-owner-sample-plugin'),
  confirmed: true,
} satisfies Omit<PrepareDownloadInput, 'repositoryRoot'>

describe('three-phase download: prepareDownload', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('download-prepare') })
  afterAll(async () => { await removeTmp(tmp) })

  async function freshRoot(name: string): Promise<string> {
    const root = join(tmp, name)
    await mkdir(root, { recursive: true })
    return root
  }

  it('clones into the staging area and returns a revocable handle without filing anything', async () => {
    const root = await freshRoot('prepare-happy')
    const { run, calls } = runner({ manifest: { main: 'index.js' }, files: ['index.js'] })
    const installer = new PluginInstaller({ run })
    const handle = await installer.prepareDownload({ repositoryRoot: root, ...prepareBase })

    expect(isDownloadToken(handle.token)).toBe(true)
    expect(handle.state).toBe('prepared')
    expect(handle.key).toBe(prepareBase.key)
    expect(handle.repository).toBe('owner/sample-plugin')
    expect(handle.refKind).toBeUndefined()
    expect(handle.localDirName).toBe('gh-owner-sample-plugin')
    expect(handle.checkoutDir).toBe(join(root, 'gh-owner-sample-plugin'))
    expect(handle.commit).toBe('a'.repeat(40))
    expect(Number.isNaN(Date.parse(handle.startedAt))).toBe(false)
    // Staged, not committed: no record yet, staging directory present.
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    expect(await store.list()).toEqual([])
    expect((await readdir(root)).filter((name) => name.startsWith('.staged-'))).toHaveLength(1)
    // Download path: git only, never a package manager.
    expect(pnpmCalls(calls)).toEqual([])
    expect(installer.stagedDownloads()).toHaveLength(1)
  })

  it('refuses without TrustGate consent and touches nothing', async () => {
    const root = await freshRoot('prepare-unconfirmed')
    const { run, calls } = runner({ manifest: {} })
    await expect(new PluginInstaller({ run }).prepareDownload({
      repositoryRoot: root,
      ...prepareBase,
      confirmed: false,
    })).rejects.toMatchObject({ code: 'gate/consent-required' })
    expect(calls).toEqual([])
    expect(await readdir(root)).toEqual([])
  })

  it('cleans the staging directory when the clone fails', async () => {
    const root = await freshRoot('prepare-clone-fail')
    const { run } = runner({ cloneCode: 128, cloneStderr: 'remote: Repository not found.' })
    const error = await new PluginInstaller({ run }).prepareDownload({ repositoryRoot: root, ...prepareBase })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MarketError)
    expect((error as MarketError).code).toBe('install/git-failed')
    expect((await readdir(root)).filter((name) => name.startsWith('.staged-'))).toEqual([])
    expect(await new PluginRecordStore(repositoryRecordsPath(root)).list()).toEqual([])
  })

  it('derives the per-ref tuple key and multi-level target for v2 downloads', async () => {
    const root = await freshRoot('prepare-v2')
    const { run } = runner({ manifest: { main: 'index.js' }, files: ['index.js'] })
    const handle = await new PluginInstaller({ run }).prepareDownload({
      repositoryRoot: root,
      ownerRepo: 'owner/sample-plugin',
      key: key('gh-owner~sample-plugin~branch~main'),
      refKind: 'branch',
      ref: 'main',
      confirmed: true,
    })
    expect(handle.localDirName).toBe('owner/sample-plugin/branch/main')
    expect(handle.refKind).toBe('branch')
    expect(handle.ref).toBe('main')
    expect(handle.checkoutDir).toBe(join(root, 'owner', 'sample-plugin', 'branch', 'main'))
  })
})

describe('three-phase download: classifyDownload', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('download-classify') })
  afterAll(async () => { await removeTmp(tmp) })

  async function prepare(name: string, fixture: Fixture): Promise<{
    installer: PluginInstaller
    handle: Awaited<ReturnType<PluginInstaller['prepareDownload']>>
  }> {
    const root = join(tmp, name)
    await mkdir(root, { recursive: true })
    const { run } = runner(fixture)
    const installer = new PluginInstaller({ run })
    const handle = await installer.prepareDownload({ repositoryRoot: root, ...prepareBase })
    return { installer, handle }
  }

  it('files a skills pack as skills even though a conventional index.js exists (mechanical probe is only a hint)', async () => {
    // The regression this guards: an index.js made the old probe call it a
    // plugin; the model's verdict must win.
    const { installer, handle } = await prepare('classify-skills', {
      manifest: { name: 'skills-pack', main: 'index.js' },
      files: ['index.js', 'SKILL.md'],
    })
    const result = await installer.classifyDownload(handle.token, {
      complete: completionOf({ kind: 'skills', reason: 'An agent skills pack, not a plugin', entryHint: null }),
      provider: 'p',
      model: 'm',
    })
    expect(result).toMatchObject({ outcome: 'classified', classification: 'skills', unclassified: false })
    expect(result.reason).toContain('skills pack')
    expect(result.entryPresent).toBe(true)
  })

  it.each(KIND_CASES)('maps the model kind to the expected classification', async (answer, expected) => {
    const { installer, handle } = await prepare(`classify-${String(answer.kind)}`, {
      manifest: { main: 'index.js' },
      files: ['index.js'],
    })
    const result = await installer.classifyDownload(handle.token, {
      complete: completionOf(answer),
      provider: 'p',
      model: 'm',
    })
    expect(result.classification).toBe(expected)
    expect(result.outcome).toBe('classified')
  })

  it('files other + unclassified when no completion backend is injected (model unavailable)', async () => {
    const { installer, handle } = await prepare('classify-no-backend', {
      manifest: { main: 'index.js' },
      files: ['index.js'],
    })
    const result = await installer.classifyDownload(handle.token)
    expect(result).toMatchObject({ outcome: 'unclassified', classification: 'other', unclassified: true })
    expect(result.reason).toContain('No smart-install model is configured')
    // The checkout is untouched and still committable.
    expect(installer.stagedDownloads()).toHaveLength(1)
  })

  it('files other + unclassified when the endpoint is not configured (llm-unconfigured)', async () => {
    const { installer, handle } = await prepare('classify-unconfigured', {
      manifest: { main: 'index.js' },
      files: ['index.js'],
    })
    const complete = vi.fn<DownloadCompletion>(async () => '{}')
    const result = await installer.classifyDownload(handle.token, { complete })
    expect(result).toMatchObject({ outcome: 'unclassified', classification: 'other', unclassified: true })
    expect(result.errorCode).toBe('market/llm-unconfigured')
    expect(complete).not.toHaveBeenCalled()
  })

  it('files other + failed when the model call fails, keeping the checkout', async () => {
    const { installer, handle } = await prepare('classify-failed', {
      manifest: { main: 'index.js' },
      files: ['index.js'],
    })
    const result = await installer.classifyDownload(handle.token, {
      complete: async () => { throw new Error('transport exploded') },
      provider: 'p',
      model: 'm',
    })
    expect(result).toMatchObject({ outcome: 'failed', classification: 'other', unclassified: true })
    expect(result.errorCode).toBe('market/llm-failed')
    expect(result.reason).toContain('Smart-install classification failed')
    expect(installer.stagedDownloads()).toHaveLength(1)
  })

  it('files other + failed when the model answer is unparsable (llm-bad-output)', async () => {
    const { installer, handle } = await prepare('classify-bad-output', { manifest: {}, files: [] })
    const result = await installer.classifyDownload(handle.token, {
      complete: async () => 'not json at all',
      provider: 'p',
      model: 'm',
    })
    expect(result).toMatchObject({ outcome: 'failed', classification: 'other', unclassified: true })
    expect(result.errorCode).toBe('market/llm-bad-output')
  })

  it('never throws for an unavailable model, and rejects an unknown token', async () => {
    const { installer, handle } = await prepare('classify-token', { manifest: {}, files: [] })
    await expect(installer.classifyDownload(handle.token)).resolves.toBeDefined()
    await expect(installer.classifyDownload('dl-nope-nope' as DownloadToken))
      .rejects.toMatchObject({ code: 'record/not-found' })
  })
})

describe('three-phase download: commitDownload + cancelDownload', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('download-commit') })
  afterAll(async () => { await removeTmp(tmp) })

  async function prepared(name: string, fixture: Fixture): Promise<{
    root: string
    installer: PluginInstaller
    handle: Awaited<ReturnType<PluginInstaller['prepareDownload']>>
    calls: RunnerCall[]
  }> {
    const root = join(tmp, name)
    await mkdir(root, { recursive: true })
    const { run, calls } = runner(fixture)
    const installer = new PluginInstaller({ run })
    const handle = await installer.prepareDownload({ repositoryRoot: root, ...prepareBase })
    return { root, installer, handle, calls }
  }

  it('swaps the checkout into place atomically and writes the record', async () => {
    const { root, installer, handle, calls } = await prepared('commit-happy', {
      manifest: { name: 'demo', main: 'lib/index.js' },
      files: ['lib/index.js'],
    })
    const classification = await installer.classifyDownload(handle.token, {
      complete: completionOf({ kind: 'plugin', reason: 'a plugin', entryHint: 'lib/index.js' }),
      provider: 'p',
      model: 'm',
    })
    const committed = await installer.commitDownload({
      token: handle.token,
      classification: classification.classification,
    })
    expect(committed).toMatchObject({
      classification: 'plugin',
      entry: 'lib/index.js',
      dependenciesInstalled: false,
      overwritten: false,
      checkoutDir: handle.checkoutDir,
    })
    expect(committed.record).toMatchObject({ classification: 'plugin', entry: 'lib/index.js', enabled: false, trusted: 'trusted' })
    // Final location exists, staging is gone, handle consumed.
    expect(await readdir(join(root, 'gh-owner-sample-plugin'))).toContain('lib')
    expect((await readdir(root)).filter((name) => name.startsWith('.staged-'))).toEqual([])
    expect(installer.stagedDownloads()).toEqual([])
    // Record reloads from disk.
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    expect((await store.get(prepareBase.key))?.classification).toBe('plugin')
    // No package manager anywhere in the download path.
    expect(pnpmCalls(calls)).toEqual([])
  })

  it('commits an entry-less skills checkout with entry null and the model label', async () => {
    const { installer, handle } = await prepared('commit-entryless', {
      manifest: { name: 'pack', main: 'lib/missing.js' },
      files: ['SKILL.md'],
    })
    const committed = await installer.commitDownload({ token: handle.token, classification: 'skills' })
    expect(committed).toMatchObject({ classification: 'skills', entry: null, dependenciesInstalled: false })
    expect(committed.record).toMatchObject({ classification: 'skills', entry: null })
  })

  it('degrades a plugin label to other when the staged checkout has no runnable entry', async () => {
    const { installer, handle } = await prepared('commit-plugin-no-entry', {
      manifest: { name: 'unbuilt', main: 'dist/index.js' },
      files: ['src/index.ts'],
    })
    const committed = await installer.commitDownload({ token: handle.token, classification: 'plugin' })
    expect(committed.classification).toBe('other')
    expect(committed.entry).toBeNull()
  })

  it('cancels a staged download with zero residue and is idempotent', async () => {
    const { root, installer, handle } = await prepared('commit-cancel', {
      manifest: { main: 'index.js' },
      files: ['index.js'],
    })
    expect(await installer.cancelDownload(handle.token)).toBe(true)
    expect((await readdir(root)).filter((name) => name.startsWith('.staged-'))).toEqual([])
    // The final checkout never appears and no record is written.
    expect(await new PluginRecordStore(repositoryRecordsPath(root)).list()).toEqual([])
    expect(await installer.cancelDownload(handle.token)).toBe(false)
    await expect(installer.commitDownload({ token: handle.token, classification: 'other' }))
      .rejects.toMatchObject({ code: 'record/not-found' })
  })

  it('never runs pnpm, and rejects an unknown token', async () => {
    const { installer, handle, calls } = await prepared('commit-no-pnpm', { manifest: {}, files: [] })
    expect(pnpmCalls(calls)).toEqual([])
    await expect(installer.commitDownload({ token: handle.token, classification: 'other' })).resolves.toBeDefined()
    expect(pnpmCalls(calls)).toEqual([])
    await expect(installer.commitDownload({ token: 'dl-x-y' as DownloadToken, classification: 'other' }))
      .rejects.toMatchObject({ code: 'record/not-found' })
  })

  it('removes stale staging roots left by an earlier crashed run', async () => {
    const root = join(tmp, 'commit-stale-staging')
    await mkdir(root, { recursive: true })
    await mkdir(join(root, '.staged-gh-owner-sample-plugin-999-0'), { recursive: true })
    const { run } = runner({ manifest: { main: 'index.js' }, files: ['index.js'] })
    const installer = new PluginInstaller({ run })
    const handle = await installer.prepareDownload({ repositoryRoot: root, ...prepareBase })
    expect((await readdir(root)).filter((name) => name === '.staged-gh-owner-sample-plugin-999-0')).toEqual([])
    expect(handle.state).toBe('prepared')
  })
})

describe('installCheckoutDependencies (standalone, not on the download path)', () => {
  it('runs pnpm install in the checkout and reports install/deps-failed on failure', async () => {
    const calls: RunnerCall[] = []
    const run: CommandRunner = async (command, args, options): Promise<CommandOutcome> => {
      calls.push({ command, args: [...args], ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) })
      return { code: 1, stdout: '', stderr: 'ERR_PNPM_NO_PKG_MANIFEST No package.json found' }
    }
    await expect(installCheckoutDependencies('/checkout', run)).rejects.toMatchObject({
      code: 'install/deps-failed',
    })
    expect(calls).toEqual([{ command: 'pnpm', args: ['install'], cwd: '/checkout' }])
  })

  it('resolves when pnpm succeeds', async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: 'done', stderr: '' })
    await expect(installCheckoutDependencies('/checkout', run)).resolves.toBeUndefined()
  })
})

describe('record classification correction (setClassification)', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('download-set-classification') })
  afterAll(async () => { await removeTmp(tmp) })

  async function seededStore(name: string, seed: {
    classification?: 'plugin' | 'skills' | 'other'
    entry?: string
  }): Promise<{ store: PluginRecordStore; file: string }> {
    const file = join(tmp, `${name}.json`)
    const store = new PluginRecordStore(file)
    await store.add({
      key: key('gh-owner-repo'),
      source: { kind: 'github', repository: 'owner/repo', version: null, commit: null },
      localDirName: 'gh-owner-repo',
      ...(seed.entry === undefined ? {} : { entry: seed.entry }),
      ...(seed.classification === undefined ? {} : { classification: seed.classification }),
    })
    return { store, file }
  }

  it('rewrites only the classification and preserves every other field', async () => {
    const { store, file } = await seededStore('preserve', { classification: 'other' })
    const before = await store.get(key('gh-owner-repo'))
    expect(before?.classification).toBe('other')
    await store.setEnabled(key('gh-owner-repo'), true)
    await store.setTrusted(key('gh-owner-repo'), 'trusted')

    const updated = await store.setClassification(key('gh-owner-repo'), 'skills')
    const previous = await new PluginRecordStore(file).get(key('gh-owner-repo'))
    expect(updated.classification).toBe('skills')
    expect(previous?.entry).toBe(before?.entry)
    expect(previous?.source).toEqual(before?.source)
    expect(previous?.localDirName).toBe(before?.localDirName)
    expect(previous?.installedAt).toBe(before?.installedAt)
    expect(previous?.enabled).toBe(true)
    expect(previous?.trusted).toBe('trusted')
    expect(previous?.trustedAt).toBe(updated.trustedAt)
  })

  it('promotes to plugin only when the record carries a runnable entry', async () => {
    const withEntry = await seededStore('promote-ok', { classification: 'other', entry: 'index.js' })
    const promoted = await withEntry.store.setClassification(key('gh-owner-repo'), 'plugin')
    expect(promoted).toMatchObject({ classification: 'plugin', entry: 'index.js' })

    const withoutEntry = await seededStore('promote-refused', { classification: 'other' })
    await expect(withoutEntry.store.setClassification(key('gh-owner-repo'), 'plugin'))
      .rejects.toMatchObject({ code: 'record/invalid' })
    // Zero side effect on rejection.
    expect((await withoutEntry.store.get(key('gh-owner-repo')))?.classification).toBe('other')
  })

  it('rejects an unknown label and a missing record', async () => {
    const { store } = await seededStore('invalid-label', { classification: 'other' })
    await expect(store.setClassification(key('gh-owner-repo'), 'preset' as never))
      .rejects.toMatchObject({ code: 'record/invalid' })
    await expect(store.setClassification(key('gh-missing'), 'other'))
      .rejects.toMatchObject({ code: 'record/not-found' })
  })
})
