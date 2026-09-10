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

  /**
   * Walk the three phases of the production adapter: prepare (clone) →
   * classify (host verdict) → commit (under the label the caller picked).
   */
  async function downloadVia(
    port: ReturnType<typeof createInstallerPort>,
    input: Parameters<ReturnType<typeof createInstallerPort>['prepare']>[0],
    label: 'plugin' | 'skills' | 'other',
  ): Promise<Awaited<ReturnType<ReturnType<typeof createInstallerPort>['commit']>>> {
    const prepared = await port.prepare(input)
    const classification = await port.classify(prepared.token)
    return await port.commit({ token: prepared.token, classification: label ?? classification.classification })
  }

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

  it('forwards the committed classification into the host installer and back', async () => {
    // A checkout with a manifest but no runnable entry: the host probe finds
    // nothing, so the label the caller committed decides the filed tag.
    const { port, store } = await portFor('skills-hint', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['README.md'],
    })
    const outcome = await downloadVia(port, {
      repositoryRoot: join(tmp, 'skills-hint'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    }, 'skills')
    expect(outcome).toMatchObject({ classification: 'skills', entry: null })
    expect(outcome.dependenciesInstalled).toBe(false)
    expect((await store.get(parsePluginKey(KEY)))?.classification).toBe('skills')
  })

  it('files an entry-less checkout as other when the caller committed plugin', async () => {
    const { port, store } = await portFor('plugin-hint', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['README.md'],
    })
    const outcome = await downloadVia(port, {
      repositoryRoot: join(tmp, 'plugin-hint'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    }, 'plugin')
    // The entry probe wins: a plugin label cannot make an entry-less checkout
    // loadable (the host folds it back to `other`).
    expect(outcome).toMatchObject({ classification: 'other', entry: null })
    expect((await store.get(parsePluginKey(KEY)))?.entry).toBeNull()
  })

  it('keeps a runnable checkout loadable when the commit label is plugin', async () => {
    const { port, store } = await portFor('probe-wins', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const outcome = await downloadVia(port, {
      repositoryRoot: join(tmp, 'probe-wins'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    }, 'plugin')
    expect(outcome).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    // Downloads never install dependencies (the standalone dependency action owns that).
    expect(outcome.dependenciesInstalled).toBe(false)
    expect((await store.get(parsePluginKey(KEY)))?.classification).toBe('plugin')
  })

  it('never runs a dependency step during a download (package manager is never invoked)', async () => {
    const skills = await portFor('deps-skipped', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['README.md'],
    })
    const skillsOutcome = await downloadVia(skills.port, {
      repositoryRoot: join(tmp, 'deps-skipped'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    }, 'skills')
    expect(skillsOutcome.dependenciesInstalled).toBe(false)
    expect(skills.calls.some(call => call.command === 'pnpm')).toBe(false)

    const plugin = await portFor('deps-runnable', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const pluginOutcome = await downloadVia(plugin.port, {
      repositoryRoot: join(tmp, 'deps-runnable'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    }, 'plugin')
    expect(pluginOutcome.dependenciesInstalled).toBe(false)
    expect(plugin.calls.some(call => call.command === 'pnpm')).toBe(false)
    // Only the clone ever reached the subprocess layer.
    expect(plugin.calls.map(call => call.command)).toEqual(['git', 'git'])
  })

  it('reports the classification phase honestly when no model is configured', async () => {
    const { port } = await portFor('unclassified', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const prepared = await port.prepare({
      repositoryRoot: join(tmp, 'unclassified'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    })
    const classification = await port.classify(prepared.token)
    // No completion configured → the host answers `unclassified` + `other`
    // instead of throwing, so the download can still be filed and corrected.
    expect(classification).toMatchObject({ outcome: 'unclassified', classification: 'other', unclassified: true })
    expect(classification.entryPresent).toBe(true)
    expect(classification.entryHint).toBe('index.js')
  })

  it('classifies through the injected model endpoint and files its verdict', async () => {
    const root = join(tmp, 'classified')
    await mkdir(root, { recursive: true })
    const store = new PluginRecordStore(repositoryRecordsPath(root))
    const repository: MarketRepository = {
      root,
      records: store,
      harnessLinks: { scopePath: join(root, 'node_modules', '@deepseek-ai'), links: [] },
      harnessVerified: null,
    }
    // A skills pack: the model names the kind and the checkout carries no
    // runnable entry, so the verdict is filed as-is.
    const { run } = fakeRunner({ manifest: { name: 'pack', main: 'lib/missing.js' }, files: ['SKILL.md'] })
    const port = createInstallerPort(repository, {
      run,
      classify: {
        provider: 'ds-provider',
        model: 'deepseek-chat',
        complete: async () => JSON.stringify({ kind: 'skills', reason: 'an agent skills pack', entryHint: null }),
      },
    })
    const prepared = await port.prepare({
      repositoryRoot: root,
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    })
    const classification = await port.classify(prepared.token)
    expect(classification).toMatchObject({ outcome: 'classified', classification: 'skills', unclassified: false })
    const committed = await port.commit({
      token: prepared.token,
      classification: classification.classification,
    })
    expect(committed).toMatchObject({ classification: 'skills', entry: null, dependenciesInstalled: false })
    expect((await store.get(parsePluginKey(KEY)))?.classification).toBe('skills')
  })

  it('walks all three phases without ever invoking a package manager', async () => {
    const { port, calls } = await portFor('zero-pnpm', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const prepared = await port.prepare({
      repositoryRoot: join(tmp, 'zero-pnpm'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    })
    const classification = await port.classify(prepared.token)
    const committed = await port.commit({ token: prepared.token, classification: classification.classification })
    expect(committed.dependenciesInstalled).toBe(false)
    // The whole download only ever ran git (clone + rev-parse).
    expect(calls.map(call => call.command)).toEqual(['git', 'git'])
    expect(calls.some(call => call.command === 'pnpm')).toBe(false)
  })

  it('cancels a staged download and reports idempotently', async () => {
    const { port } = await portFor('cancel', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const prepared = await port.prepare({
      repositoryRoot: join(tmp, 'cancel'),
      key: parsePluginKey(KEY),
      repository: SLUG,
      version: null,
    })
    await expect(port.cancel(prepared.token)).resolves.toBe(true)
    await expect(port.cancel(prepared.token)).resolves.toBe(false)
    await expect(port.commit({ token: prepared.token, classification: 'plugin' })).rejects.toMatchObject({
      code: 'record/not-found',
    })
  })

  it('passes the ref-kind tuple through and reports it on the record', async () => {
    const { port, store } = await portFor('v2-ref', {
      manifest: { name: 'demo-plugin', main: 'index.js' },
      files: ['index.js'],
    })
    const key = (await import('../src/host/market/keys.ts')).pluginKeyForGithubRef(SLUG, 'branch', 'dev')
    const outcome = await downloadVia(port, {
      repositoryRoot: join(tmp, 'v2-ref'),
      key,
      repository: SLUG,
      refKind: 'branch',
      version: 'dev',
    }, 'plugin')
    expect(outcome).toMatchObject({ classification: 'plugin', entry: 'index.js' })
    const record = await store.get(key)
    expect(record?.localDirName).toBe('octocat/demo-plugin/branch/dev')
    expect(record?.source).toMatchObject({ kind: 'github', refKind: 'branch', version: 'dev' })
  })
})
