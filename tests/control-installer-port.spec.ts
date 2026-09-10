/**
 * Port-level spec of the production installer adapter: the real
 * `createInstallerPort` over a real `PluginInstaller` whose subprocesses are
 * stubbed (the same fake-runner pattern market-install.spec uses), so the
 * adapter's own field mapping is what is asserted.
 *
 * This is the regression guard for the reviewed defect: `source.install()`
 * hands the reviewed classification to the `InstallerPort`, and tsc cannot see
 * a missing forward (the host field is optional). The test fails loudly if the
 * adapter stops forwarding `classification`, or stops reporting the install
 * facts (`classification`/`entry`/`entryNote`/`dependenciesInstalled`) back.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CommandOutcome,
  type CommandRunner,
} from '../src/host/market/install.ts'
import { repositoryRecordsPath } from '../src/host/market/layout.ts'
import { PluginRecordStore } from '../src/host/market/records.ts'
import type { MarketRepository } from '../src/host/market/index.ts'
import { createInstallerPort } from '../src/host/control/installer-port.ts'
import { parsePluginKey } from '../src/host/market/keys.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

const SLUG = 'octocat/demo-plugin'
const KEY = 'gh-octocat-demo-plugin'

/** One checkout the fake git understands. */
interface Fixture {
  /** package.json body; `null` means the clone step fails (repository missing). */
  readonly manifest?: Record<string, unknown> | null
  /** Files written into the checkout (default `index.js`). */
  readonly files?: readonly string[]
}

/** Fake git/pnpm runner staging a real checkout on disk. */
function fakeRunner(fixture: Fixture): {
  run: CommandRunner
  calls: { command: string; args: string[] }[]
} {
  const calls: { command: string; args: string[] }[] = []
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] })
    const all = [...args]
    if (command === 'git' && all[0] === 'clone') {
      const target = all[all.length - 1] ?? ''
      await mkdir(target, { recursive: true })
      await mkdir(join(target, '.git'), { recursive: true })
      if (fixture.manifest === null) {
        const outcome: CommandOutcome = { code: 128, stdout: '', stderr: 'remote: Repository not found.' }
        return outcome
      }
      await writeFile(join(target, 'package.json'), JSON.stringify(fixture.manifest ?? {}), 'utf8')
      for (const file of fixture.files ?? ['index.js']) {
        const segments = file.split('/')
        const name = segments.pop() ?? ''
        if (name === '') continue
        await mkdir(join(target, ...segments), { recursive: true })
        await writeFile(join(target, ...segments, name), 'export const value = 1\n', 'utf8')
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && all.includes('rev-parse')) {
      return { code: 0, stdout: 'a'.repeat(40), stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('createInstallerPort (production adapter mapping)', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('control-installer-port') })
  afterAll(async () => { await removeTmp(tmp) })

  async function portFor(name: string, fixture: Fixture): Promise<{
    port: ReturnType<typeof createInstallerPort>
    store: PluginRecordStore
    root: string
    calls: { command: string; args: string[] }[]
  }> {
    const root = join(tmp, name)
    await mkdir(root, { recursive: true })
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    const repository: MarketRepository = {
      root,
      records: store,
      harnessLinks: { scopePath: join(root, 'node_modules', '@deepseek-ai'), links: [] },
      harnessVerified: null,
    }
    const { run, calls } = fakeRunner(fixture)
    const port = createInstallerPort(repository, { run })
    return { port, store, root, calls }
  }

  it('forwards the reviewed classification into the host installer and back', async () => {
    // A checkout with a manifest but no runnable entry: the host probe finds
    // nothing, so the reviewed hint decides the filed tag.
    const { port, store } = await portFor('skills-hint', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['README.md'],
    })
    const outcome = await port.install({
      repositoryRoot: join(tmp, 'skills-hint'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
      classification: 'skills',
    })
    expect(outcome).toMatchObject({ classification: 'skills', entry: null })
    expect(outcome.entryNote).not.toBeNull()
    expect(outcome.dependenciesInstalled).toBe(false)
    expect((await store.get(parsePluginKey(KEY)))?.classification).toBe('skills')
  })

  it('files an entry-less checkout as other when the review predicted plugin', async () => {
    const { port, store } = await portFor('plugin-hint', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['README.md'],
    })
    const outcome = await port.install({
      repositoryRoot: join(tmp, 'plugin-hint'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
      classification: 'plugin',
    })
    // The entry probe wins: a plugin hint cannot make an entry-less checkout
    // loadable.
    expect(outcome).toMatchObject({ classification: 'other', entry: null })
    expect((await store.get(parsePluginKey(KEY)))?.entry).toBeNull()
  })

  it('lets the entry probe win over a non-plugin hint (runnable checkout stays loadable)', async () => {
    const { port, store } = await portFor('probe-wins', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const outcome = await port.install({
      repositoryRoot: join(tmp, 'probe-wins'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
      classification: 'skills',
    })
    expect(outcome).toMatchObject({ classification: 'plugin', entry: 'index.js', entryNote: null })
    expect(outcome.dependenciesInstalled).toBe(true)
    expect((await store.get(parsePluginKey(KEY)))?.classification).toBe('plugin')
  })

  it('runs the dependency step only for a classified plugin (deps skipped otherwise)', async () => {
    const skills = await portFor('deps-skipped', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['README.md'],
    })
    await skills.port.install({
      repositoryRoot: join(tmp, 'deps-skipped'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
      classification: 'skills',
    })
    expect(skills.calls.some(call => call.command === 'pnpm')).toBe(false)

    const plugin = await portFor('deps-run', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    await plugin.port.install({
      repositoryRoot: join(tmp, 'deps-run'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
      classification: 'plugin',
    })
    expect(plugin.calls.some(call => call.command === 'pnpm')).toBe(true)
  })

  it('passes the ref-kind tuple through and reports it on the record', async () => {
    const { port, store } = await portFor('v2-ref', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const key = (await import('../src/host/market/keys.ts')).pluginKeyForGithubRef(SLUG, 'branch', 'dev')
    const outcome = await port.install({
      repositoryRoot: join(tmp, 'v2-ref'),
      key,
      repository: SLUG,
      refKind: 'branch',
      version: 'dev',
      classification: 'plugin',
    })
    expect(outcome).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    const record = await store.get(key)
    expect(record?.localDirName).toBe('octocat/demo-plugin/branch/dev')
    expect(record?.source).toMatchObject({ kind: 'github', refKind: 'branch', version: 'dev' })
  })
})
