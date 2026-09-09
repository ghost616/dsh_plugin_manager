import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PluginMarketGithubSource, PluginMarketSource } from '../src/types.ts'
import { MarketError } from '../src/host/market/errors.ts'
import {
  DEFAULT_CHECKOUT_ENTRY,
  PluginInstaller,
  resolveCheckoutEntry,
  resolveInstallTarget,
  type CommandOutcome,
  type CommandRunner,
} from '../src/host/market/install.ts'
import { parsePluginKey, pluginKeyForGithubRef } from '../src/host/market/keys.ts'
import { repositoryRecordsPath } from '../src/host/market/layout.ts'
import { PluginRecordStore } from '../src/host/market/records.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

const githubSource: PluginMarketSource = {
  kind: 'github',
  repository: 'owner/sample-plugin',
  version: null,
  commit: null,
}

function key(value: string) {
  return parsePluginKey(value)
}

async function rejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    expect((error as MarketError).code).toBe(code)
    return
  }
  throw new Error(`expected MarketError with code ${code}, but the promise resolved`)
}

/** Fixture consumed by the fake git/pnpm runner. */
interface InstallFixture {
  manifest: Record<string, unknown> | null
  files?: string[]
  failPnpm?: boolean
  sha?: string
}

interface RunnerCall {
  command: string
  args: string[]
  cwd?: string
}

function fakeRunner(fixture: InstallFixture): { run: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd })
    const all = [...args]
    if (command === 'git' && all[0] === 'clone') {
      const target = all[all.length - 1] ?? ''
      await mkdir(target, { recursive: true })
      await mkdir(join(target, '.git'))
      if (fixture.manifest === null) {
        const outcome: CommandOutcome = { code: 128, stdout: '', stderr: 'remote: Repository not found.' }
        return outcome
      }
      await writeFile(join(target, 'package.json'), JSON.stringify(fixture.manifest), 'utf8')
      for (const file of fixture.files ?? ['index.js']) {
        const segments = file.split('/')
        const name = segments.pop()
        if (name !== undefined) await mkdir(join(target, ...segments), { recursive: true })
        await writeFile(join(target, ...segments, name), 'export const value = 1\n', 'utf8')
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && all.includes('rev-parse')) {
      return { code: 0, stdout: fixture.sha ?? 'a'.repeat(40), stderr: '' }
    }
    if (command === 'pnpm' && all[0] === 'install') {
      if (fixture.failPnpm) return { code: 1, stdout: '', stderr: 'ERR_PNPM_FAILED install failed' }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('PluginInstaller.install', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('install') })
  afterAll(async () => { await removeTmp(tmp) })

  async function freshRepo(name: string): Promise<string> {
    const root = join(tmp, name)
    await mkdir(root)
    return root
  }

  it('refuses an unconfirmed install before any side effect', async () => {
    const root = await freshRepo('repo-unconfirmed')
    const { run, calls } = fakeRunner({ manifest: { main: 'lib/index.js' }, files: ['lib/index.js'] })
    const installer = new PluginInstaller({ run })
    await rejectCode(
      installer.install({
        repositoryRoot: root,
        key: key('gh-owner-repo'),
        ownerRepo: 'owner/sample-plugin',
        confirmed: false,
      }),
      'gate/consent-required',
    )
    expect(calls).toEqual([])
    expect(await readdir(root)).toEqual([])
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    expect(await store.list()).toEqual([])
  })

  it('clones, installs and registers a confirmed plugin with defaults and trust', async () => {
    const root = await freshRepo('repo-success')
    const { run, calls } = fakeRunner({
      manifest: { name: 'sample-plugin', main: 'lib/index.js' },
      files: ['lib/index.js', 'lib/util.js'],
      sha: 'b'.repeat(40),
    })
    const installer = new PluginInstaller({ run })
    const result = await installer.install({
      repositoryRoot: root,
      key: key('gh-owner-repo'),
      ownerRepo: 'owner/sample-plugin',
      confirmed: true,
    })
    expect(result.record.enabled).toBe(false)
    expect(result.record.trusted).toBe('trusted')
    expect(result.record.trustedAt).not.toBeNull()
    expect(result.record.entry).toBe('lib/index.js')
    expect(result.record.localDirName).toBe('gh-owner-repo')
    expect(result.record.source).toMatchObject({ kind: 'github', repository: 'owner/sample-plugin' })
    expect((result.record.source as PluginMarketGithubSource).commit).toBe('b'.repeat(40))

    // The checkout and conventions landed on disk; git/pnpm ran once each.
    const pkg = JSON.parse(await readFile(join(root, 'gh-owner-repo', 'package.json'), 'utf8')) as { main: string }
    expect(pkg.main).toBe('lib/index.js')
    // The final directory is a managed checkout: it holds the `.git` created
    // by the (fake) clone, not a leftover of any pre-existing data.
    expect(await readdir(join(root, 'gh-owner-repo', '.git'))).toEqual([])
    expect(calls.some((call) => call.command === 'git' && call.args[0] === 'clone')).toBe(true)
    expect(calls.some((call) => call.command === 'pnpm')).toBe(true)

    // Reload: the record persisted exactly once with the defaults above.
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    expect(await store.list()).toHaveLength(1)
    expect((await store.get(key('gh-owner-repo')))?.enabled).toBe(false)
  })

  it('falls back to the conventional entry when the manifest resolves none', async () => {
    const root = await freshRepo('repo-minimal')
    const { run } = fakeRunner({ manifest: { name: 'minimal' }, files: ['index.js'] })
    const installer = new PluginInstaller({ run })
    const result = await installer.install({
      repositoryRoot: root,
      key: key('gh-minimal'),
      ownerRepo: 'owner/minimal',
      localDirName: 'gh-minimal',
      confirmed: true,
    })
    expect(result.record.entry).toBe(DEFAULT_CHECKOUT_ENTRY)
  })

  it('reports entry-missing and rolls back when no entry file exists', async () => {
    const root = await freshRepo('repo-entry-missing')
    const { run } = fakeRunner({ manifest: { main: 'lib/main.js' }, files: ['lib/other.js'] })
    const installer = new PluginInstaller({ run })
    await rejectCode(
      installer.install({
        repositoryRoot: root,
        key: key('gh-missing-entry'),
        ownerRepo: 'owner/missing',
        localDirName: 'gh-missing-entry',
        confirmed: true,
      }),
      'install/entry-missing',
    )
    const dirs = await readdir(root)
    expect(dirs.some((name) => name === 'gh-missing-entry')).toBe(false)
    expect(dirs.some((name) => name.startsWith('.install-'))).toBe(false)
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    expect(await store.get(key('gh-missing-entry'))).toBeNull()
  })

  it('reports deps-failed and rolls back on a pnpm failure', async () => {
    const root = await freshRepo('repo-deps-fail')
    const { run } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'], failPnpm: true })
    const installer = new PluginInstaller({ run })
    await rejectCode(
      installer.install({
        repositoryRoot: root,
        key: key('gh-deps-fail'),
        ownerRepo: 'owner/depsfail',
        localDirName: 'gh-deps-fail',
        confirmed: true,
      }),
      'install/deps-failed',
    )
    const dirs = await readdir(root)
    expect(dirs.some((name) => name === 'gh-deps-fail')).toBe(false)
    expect(dirs.some((name) => name.startsWith('.install-'))).toBe(false)
  })

  it('overwrite-updates the same key (stale checkout removed, single record)', async () => {
    const root = await freshRepo('repo-overwrite')
    const first = fakeRunner({ manifest: { main: 'a.js' }, files: ['a.js'] })
    await new PluginInstaller({ run: first.run }).install({
      repositoryRoot: root,
      key: key('gh-owner-repo'),
      ownerRepo: 'owner/sample-plugin',
      localDirName: 'gh-owner-repo',
      confirmed: true,
    })
    const second = fakeRunner({ manifest: { main: 'b.js' }, files: ['b.js'] })
    const result = await new PluginInstaller({ run: second.run }).install({
      repositoryRoot: root,
      key: key('gh-owner-repo'),
      ownerRepo: 'owner/sample-plugin',
      localDirName: 'gh-owner-repo-v2',
      confirmed: true,
    })
    expect(result.record.entry).toBe('b.js')
    expect(result.record.localDirName).toBe('gh-owner-repo-v2')

    const dirs = await readdir(root)
    expect(dirs.some((name) => name === 'gh-owner-repo')).toBe(false)
    expect(dirs.some((name) => name === 'gh-owner-repo-v2')).toBe(true)
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]?.localDirName).toBe('gh-owner-repo-v2')
  })

  it('refuses to overwrite a non-managed non-empty directory', async () => {
    const root = await freshRepo('repo-occupied')
    const occupied = join(root, 'gh-occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'notes.txt'), 'user file', 'utf8')
    const { run } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] })
    await rejectCode(
      new PluginInstaller({ run }).install({
        repositoryRoot: root,
        key: key('gh-occupied'),
        ownerRepo: 'owner/occupied',
        localDirName: 'gh-occupied',
        confirmed: true,
      }),
      'install/dir-exists',
    )
    expect(await readFile(join(occupied, 'notes.txt'), 'utf8')).toBe('user file')
    expect(await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-occupied'))).toBeNull()
  })

  it('refuses an existing directory that holds its own .git but has no record (no hasGit pass-through)', async () => {
    const root = await freshRepo('repo-gitlike')
    const dir = join(root, 'gh-gitlike')
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, 'README.md'), 'user repository', 'utf8')
    const { run, calls } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] })
    await rejectCode(
      new PluginInstaller({ run }).install({
        repositoryRoot: root,
        key: key('gh-gitlike'),
        ownerRepo: 'owner/gitlike',
        localDirName: 'gh-gitlike',
        confirmed: true,
      }),
      'install/dir-exists',
    )
    // The user-owned git repository survives untouched and nothing was cloned
    // into the repository root.
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('user repository')
    expect(await readdir(join(dir, '.git'))).toEqual([])
    expect(calls).toEqual([])
    expect(await new PluginRecordStore(repositoryRecordsPath(root)).get(key('gh-gitlike'))).toBeNull()
  })

  it('allows an existing empty directory and installs into it', async () => {
    const root = await freshRepo('repo-empty')
    const dir = join(root, 'gh-empty')
    await mkdir(dir)
    const { run } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] })
    const result = await new PluginInstaller({ run }).install({
      repositoryRoot: root,
      key: key('gh-empty'),
      ownerRepo: 'owner/empty',
      localDirName: 'gh-empty',
      confirmed: true,
    })
    expect(result.record.entry).toBe('index.js')
    expect(result.record.localDirName).toBe('gh-empty')
    expect(await readdir(join(dir, '.git'))).toEqual([])
  })

  it('overwrite-updates the same key into the very directory it already manages', async () => {
    const root = await freshRepo('repo-self-dir')
    const dirName = 'gh-same'
    const first = fakeRunner({ manifest: { main: 'a.js' }, files: ['a.js'] })
    await new PluginInstaller({ run: first.run }).install({
      repositoryRoot: root,
      key: key('gh-same'),
      ownerRepo: 'owner/sample',
      localDirName: dirName,
      confirmed: true,
    })
    // The managed checkout physically holds a .git; a same-key same-directory
    // re-install is this manager's own overwrite update and must still pass.
    const second = fakeRunner({ manifest: { main: 'b.js' }, files: ['b.js'] })
    const result = await new PluginInstaller({ run: second.run }).install({
      repositoryRoot: root,
      key: key('gh-same'),
      ownerRepo: 'owner/sample',
      localDirName: dirName,
      confirmed: true,
    })
    expect(result.record.entry).toBe('b.js')
    expect(result.record.localDirName).toBe(dirName)
    const pkg = JSON.parse(await readFile(join(root, dirName, 'package.json'), 'utf8')) as { main: string }
    expect(pkg.main).toBe('b.js')
    expect(await readdir(join(root, dirName, '.git'))).toEqual([])
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    expect(await store.list()).toHaveLength(1)
    expect((await store.get(key('gh-same')))?.entry).toBe('b.js')
  })

  it('refuses a directory used by another managed plugin', async () => {
    const root = await freshRepo('repo-collide')
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    await store.add({ key: key('gh-other'), source: githubSource, localDirName: 'gh-other' })
    const { run } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] })
    await rejectCode(
      new PluginInstaller({ run }).install({
        repositoryRoot: root,
        key: key('gh-collide'),
        ownerRepo: 'owner/collide',
        localDirName: 'gh-other',
        confirmed: true,
      }),
      'install/dir-in-use',
    )
  })

  describe('v2 multi-level ref installs', () => {
    async function freshRefRepo(name: string): Promise<string> {
      const root = join(tmp, name)
      await mkdir(root)
      return root
    }

    it('installs a branch into <owner>/<repo>/branch/<refSeg> with a tuple key', async () => {
      const root = await freshRefRepo('v2-branch')
      const slug = 'owner/sample-plugin'
      const installKey = pluginKeyForGithubRef(slug, 'branch', 'main')
      const { run, calls } = fakeRunner({ manifest: { main: 'lib/index.js' }, files: ['lib/index.js'] })
      const result = await new PluginInstaller({ run }).install({
        repositoryRoot: root,
        key: installKey,
        ownerRepo: slug,
        refKind: 'branch',
        ref: 'main',
        confirmed: true,
      })
      expect(result.record.key).toBe(installKey)
      expect(result.record.localDirName).toBe('owner/sample-plugin/branch/main')
      const source = result.record.source as PluginMarketGithubSource
      expect(source.refKind).toBe('branch')
      expect(source.version).toBe('main')
      expect(await readdir(join(root, 'owner', 'sample-plugin', 'branch', 'main', '.git'))).toEqual([])
      const cloneCall = calls.find((call) => call.command === 'git' && call.args[0] === 'clone')
      expect(cloneCall?.args).toContain('--branch')
      expect(cloneCall?.args).toContain('main')
    })

    it('installs a tag under tag/<refSeg>', async () => {
      const root = await freshRefRepo('v2-tag')
      const slug = 'owner/sample-plugin'
      const installKey = pluginKeyForGithubRef(slug, 'tag', 'v1.2.3')
      const { run } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] })
      const result = await new PluginInstaller({ run }).install({
        repositoryRoot: root,
        key: installKey,
        ownerRepo: slug,
        refKind: 'tag',
        ref: 'v1.2.3',
        confirmed: true,
      })
      expect(result.record.key).toBe(installKey)
      expect(result.record.localDirName).toBe('owner/sample-plugin/tag/v1%2e2%2e3')
      expect((result.record.source as PluginMarketGithubSource).refKind).toBe('tag')
      expect((result.record.source as PluginMarketGithubSource).version).toBe('v1.2.3')
    })

    it('coexists: two refs of the same repository are independent records/dirs', async () => {
      const root = await freshRefRepo('v2-coexist')
      const slug = 'owner/sample-plugin'
      const mainKey = pluginKeyForGithubRef(slug, 'branch', 'main')
      const devKey = pluginKeyForGithubRef(slug, 'branch', 'feature/dev')
      const installer = new PluginInstaller({ run: fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] }).run })
      await installer.install({
        repositoryRoot: root, key: mainKey, ownerRepo: slug, refKind: 'branch', ref: 'main', confirmed: true,
      })
      await installer.install({
        repositoryRoot: root, key: devKey, ownerRepo: slug, refKind: 'branch', ref: 'feature/dev', confirmed: true,
      })
      const store = new PluginRecordStore(repositoryRecordsPath(root))
      const records = await store.list()
      expect(records).toHaveLength(2)
      expect(records.map((record) => record.key).sort()).toEqual([mainKey, devKey].sort())
      const dirs = records.map((record) => record.localDirName).sort()
      expect(dirs).toEqual(['owner/sample-plugin/branch/feature%2fdev', 'owner/sample-plugin/branch/main'])
    })

    it('overwrite-updates the same tuple (same key/dir) into one record', async () => {
      const root = await freshRefRepo('v2-overwrite')
      const slug = 'owner/sample-plugin'
      const installKey = pluginKeyForGithubRef(slug, 'branch', 'main')
      const first = fakeRunner({ manifest: { main: 'a.js' }, files: ['a.js'] })
      await new PluginInstaller({ run: first.run }).install({
        repositoryRoot: root, key: installKey, ownerRepo: slug, refKind: 'branch', ref: 'main', confirmed: true,
      })
      const second = fakeRunner({ manifest: { main: 'b.js' }, files: ['b.js'] })
      const result = await new PluginInstaller({ run: second.run }).install({
        repositoryRoot: root, key: installKey, ownerRepo: slug, refKind: 'branch', ref: 'main', confirmed: true,
      })
      expect(result.record.entry).toBe('b.js')
      const store = new PluginRecordStore(repositoryRecordsPath(root))
      const all = await store.list()
      expect(all).toHaveLength(1)
      expect(all[0]?.localDirName).toBe('owner/sample-plugin/branch/main')
      const pkg = JSON.parse(await readFile(join(root, 'owner', 'sample-plugin', 'branch', 'main', 'package.json'), 'utf8')) as { main: string }
      expect(pkg.main).toBe('b.js')
    })

    it('rejects a mismatched v2 key before cloning anything', async () => {
      const root = await freshRefRepo('v2-bad-key')
      const slug = 'owner/sample-plugin'
      const { run, calls } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] })
      await rejectCode(
        new PluginInstaller({ run }).install({
          repositoryRoot: root,
          key: key('gh-wrong-key'),
          ownerRepo: slug,
          refKind: 'branch',
          ref: 'main',
          confirmed: true,
        }),
        'record/key-invalid',
      )
      expect(calls).toEqual([])
    })

    it('refuses to overwrite a non-managed non-empty directory at the v2 target', async () => {
      const root = await freshRefRepo('v2-occupied')
      const slug = 'owner/sample-plugin'
      const target = join(root, 'owner', 'sample-plugin', 'branch', 'main')
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'notes.txt'), 'user file', 'utf8')
      const installKey = pluginKeyForGithubRef(slug, 'branch', 'main')
      const { run, calls } = fakeRunner({ manifest: { main: 'index.js' }, files: ['index.js'] })
      await rejectCode(
        new PluginInstaller({ run }).install({
          repositoryRoot: root,
          key: installKey,
          ownerRepo: slug,
          refKind: 'branch',
          ref: 'main',
          confirmed: true,
        }),
        'install/dir-exists',
      )
      expect(await readFile(join(target, 'notes.txt'), 'utf8')).toBe('user file')
      expect(calls).toEqual([])
    })
  })
})

describe('resolveInstallTarget', () => {
  const base = { repositoryRoot: '/store', ownerRepo: 'owner/sample-plugin', confirmed: true }

  it('maps a v2 branch tuple to a derived key and multi-level dir', () => {
    const target = resolveInstallTarget('owner/sample-plugin', {
      ...base,
      key: pluginKeyForGithubRef('owner/sample-plugin', 'branch', 'main'),
      refKind: 'branch',
      ref: 'main',
    })
    expect(target.key).toBe(pluginKeyForGithubRef('owner/sample-plugin', 'branch', 'main'))
    expect(target.dirName).toBe('owner/sample-plugin/branch/main')
    expect(target.refName).toBe('main')
  })

  it('escapes a slash-containing branch into its refSeg dir', () => {
    const key = pluginKeyForGithubRef('owner/sample-plugin', 'branch', 'feature/x')
    const target = resolveInstallTarget('owner/sample-plugin', {
      ...base, key, refKind: 'branch', ref: 'feature/x',
    })
    expect(target.dirName).toBe('owner/sample-plugin/branch/feature%2fx')
  })

  it('keeps a legacy install (no refKind) on the caller-provided single dir', () => {
    const target = resolveInstallTarget('owner/sample-plugin', {
      ...base, key: key('gh-owner-repo'), localDirName: 'gh-owner-repo',
    })
    expect(target.refKind).toBeUndefined()
    expect(target.dirName).toBe('gh-owner-repo')
    expect(target.key).toBe(key('gh-owner-repo'))
  })

  it('rejects a missing ref on a v2 install', () => {
    expect(() => resolveInstallTarget('owner/sample-plugin', {
      ...base, key: key('gh-x'), refKind: 'branch',
    })).toThrow(MarketError)
  })

  it('rejects a slug that cannot form safe directory segments', () => {
    const slug = 'owner/..'
    expect(() => resolveInstallTarget(slug, {
      ...base,
      key: parsePluginKey('gh-x'),
      refKind: 'branch',
      ref: 'main',
    })).toThrow(MarketError)
  })
})

describe('resolveCheckoutEntry', () => {
  it('prefers the explicit override over main and exports', () => {
    expect(resolveCheckoutEntry('custom/entry.js', { main: 'main.js' })).toBe('custom/entry.js')
  })

  it('resolves package.json main with a stripped ./ prefix', () => {
    expect(resolveCheckoutEntry(undefined, { main: './lib/index.js' })).toBe('lib/index.js')
  })

  it('resolves exports["."] strings and conditional objects', () => {
    expect(resolveCheckoutEntry(undefined, { exports: './dist/index.js' })).toBe('dist/index.js')
    expect(resolveCheckoutEntry(undefined, { exports: { '.': { import: './dist/esm.js', require: './dist/cjs.js' } } })).toBe('dist/esm.js')
  })

  it('falls back to the conventional entry otherwise', () => {
    expect(resolveCheckoutEntry(undefined, { name: 'x' })).toBe('index.js')
    expect(resolveCheckoutEntry('', { main: 12 })).toBe('index.js')
  })
})
