import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PluginRecordStore } from '../src/host/market/records.ts'
import { MarketPluginController } from '../src/host/control/controller.ts'
import { createLoaderAdapter } from '../src/host/control/loader-adapter.ts'
import { isProtectedRecordKey } from '../src/host/control/protect.ts'
import { entryModuleName, resolveEntryPath } from '../src/host/control/entry-name.ts'
import { NodeFs } from '../src/host/market/fs.ts'
import { key, demoPluginSource, DEMO_LOG_KEY } from './support/control-testbed.ts'

const contexts: Context[] = []
const scratchRoots: string[] = []

beforeEach(() => {
  ;(globalThis as Record<symbol, unknown>)[DEMO_LOG_KEY] = []
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  delete (globalThis as Record<symbol, unknown>)[DEMO_LOG_KEY]
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * 攻关 A demo: point the Loader at a plugin entry inside a user-chosen
 * directory and drive the full 登记 → 启用 → 停用 → 重启重建 chain against the
 * real Cordis Loader + a real records file, verifying @deepseek-ai resolves
 * to the single instance (the test's own import identity). The demo checkout
 * lives inside this workspace, whose node_modules is the shared harness scope;
 * an arbitrary-volume repository reaches the same scope through the shared
 * `node_modules/@deepseek-ai` junction links (see plugin-market-host).
 */
describe('loader import from a user directory (攻关 A)', () => {
  it('registers, enables, disables, and restart-rebuilds a real plugin', async () => {
    const repoRoot = join('tests', '.tmp', `demo-${randomUUID()}`)
    const checkout = join(repoRoot, 'gh-demo-greet')
    mkdirSync(checkout, { recursive: true })
    scratchRoots.push(repoRoot)
    writeFileSync(join(checkout, 'plugin.mjs'), demoPluginSource('demo-greet-plugin', '@deepseek-ai/cordis'), 'utf8')

    const store = new PluginRecordStore(join(repoRoot, 'plugins.json'))
    await store.load()
    const record = await store.add({
      key: key('gh-demo-greet'),
      source: { kind: 'github', repository: 'demo/plugin', version: 'v1.0.0', commit: null },
      localDirName: 'gh-demo-greet',
      entry: 'plugin.mjs',
    })

    const log = () => (globalThis as Record<symbol, { kind: string }[]>)[DEMO_LOG_KEY] as { kind: string }[]
    const ups = () => log().filter(entry => entry.kind === 'up').length
    const downs = () => log().filter(entry => entry.kind === 'down').length

    // Boot one: a real Cordis Context with the real Loader service.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    const controller = makeController(ctx, repoRoot, store)
    await controller.rebuild()

    // Disabled by default: the row exists (id = record key) but nothing loads.
    const before = await controller.list()
    expect(before.entries[0]).toMatchObject({
      key: 'gh-demo-greet',
      runtime: { moduleName: expect.stringContaining('plugin.mjs'), disabled: true, phase: null },
    })
    expect(ups()).toBe(0)

    // Enable → the loader imports the checkout entry (absolute file URL).
    await controller.setEnabled(record.key, true)
    const enabledView = (await controller.list()).entries[0]
    expect(enabledView?.runtime.phase).toBe('active')
    expect(enabledView?.runtime.moduleName).toBe(entryModuleName(repoRoot, record))
    expect(ups()).toBe(1)

    // Single instance: the fixture's own cordis import is the very class this
    // test imports (both resolve to the same physical node_modules).
    const fixture = await import(entryModuleName(repoRoot, record)) as { appliedCordisContext: unknown }
    expect(fixture.appliedCordisContext).toBe(Context)

    // 停用: fiber unloads; sources and records stay for re-enable.
    await controller.setEnabled(record.key, false)
    expect((await controller.list()).entries[0]?.runtime.phase).toBeNull()
    expect(downs()).toBe(1)
    expect(await store.get(record.key)).toMatchObject({ enabled: false })
    expect(resolveEntryPath(repoRoot, record)).toContain('plugin.mjs')

    // Re-enable: the cached module applies again on the same instance.
    await controller.setEnabled(record.key, true)
    expect(ups()).toBe(2)

    // A missing entry file is a load failure, never a control crash.
    await store.add({
      key: key('gh-broken'),
      source: { kind: 'github', repository: 'demo/broken', version: null, commit: null },
      localDirName: 'gh-broken',
      entry: 'missing.mjs',
    })
    await expect(controller.setEnabled(key('gh-broken'), true)).rejects.toMatchObject({
      code: 'market/load-failed',
    })
    const broken = (await controller.list()).entries.find(row => row.key === 'gh-broken')
    expect(broken?.runtime.lastError).toContain('missing.mjs')

    // 重启重建: a second boot over the same records + a fresh loader restores
    // enabled/disabled phases from the records alone.
    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(Loader)
    const controller2 = makeController(ctx2, repoRoot, store)
    await controller2.rebuild()
    const restarted = await controller2.list()
    expect(restarted.entries.find(row => row.key === 'gh-demo-greet')?.runtime.phase).toBe('active')
    expect(restarted.entries.find(row => row.key === 'gh-demo-greet')?.runtime.moduleName)
      .toBe(entryModuleName(repoRoot, record))
    expect(restarted.entries.find(row => row.key === 'gh-broken')?.runtime.lastError).toContain('missing.mjs')
    expect(ups()).toBe(3)

    // Teardown of the second boot removes its loader rows.
    await controller2.dispose()
    expect([...ctx2.loader.entries()]).toHaveLength(0)
  })
})

function makeController(
  ctx: Context,
  repoRoot: string,
  store: PluginRecordStore,
): MarketPluginController {
  return new MarketPluginController({
    repositoryRoot: repoRoot,
    records: store,
    loader: createLoaderAdapter(ctx.loader),
    removeDirectory: async (directory) => { await NodeFs.rmrf(directory) },
    // Key protection stays real; self-module containment is a deployment-path
    // guard (the manager's own installed package) and is off for this dev
    // workspace demo, whose scratch repo legitimately lives under the repo.
    protection: { isProtectedKey: isProtectedRecordKey, isSelfModule: () => false },
    entryModuleOf: (record) => entryModuleName(repoRoot, record),
    entryDirectoryOf: (record) => join(repoRoot, record.localDirName),
    logger: { warn: () => {}, error: () => {} },
  })
}