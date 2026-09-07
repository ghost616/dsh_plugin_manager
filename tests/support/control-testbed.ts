/**
 * Shared fakes for plugin-control-service specs: an in-memory record store, a
 * scripted loader adapter, and a controller-environment factory. Records are
 * built through the stable-key validator so branded keys flow through the
 * controller like real wire keys.
 */

import type { Plugin } from '@deepseek-ai/cordis'
import type {
  ManagedPluginPhase,
  PluginMarketGithubSource,
  PluginMarketKey,
  PluginMarketRecord,
} from '../../src/types.ts'
import { parsePluginKey } from '../../src/host/market/keys.ts'
import {
  MarketPluginController,
  type MarketControllerDeps,
  type RecordsPort,
} from '../../src/host/control/controller.ts'
import type {
  LoaderAdapter,
  LoaderCreateInput,
  LoaderEntryView,
} from '../../src/host/control/loader-adapter.ts'
import { isProtectedRecordKey } from '../../src/host/control/protect.ts'
import type { PluginMarketSource } from '../../src/types.ts'

/** Scripted loader adapter with real create/update/remove/rollback shape. */
export class FakeLoader implements LoaderAdapter {
  /** Creation history (ids in order) for order assertions. */
  readonly created: string[] = []
  private readonly rows = new Map<string, LoaderEntryView>()

  entries(): LoaderEntryView[] {
    return [...this.rows.values()]
  }

  async create(input: LoaderCreateInput): Promise<void> {
    this.created.push(input.id)
    if (!input.disabled && input.moduleName.includes('__broken__')) {
      throw new Error('boom: plugin failed to load')
    }
    this.rows.set(input.id, {
      id: input.id,
      moduleName: input.moduleName,
      disabled: input.disabled,
      phase: input.disabled ? null : 'active',
    })
  }

  async update(id: string, options: { disabled?: boolean }): Promise<void> {
    if (options.disabled === undefined) return
    const entry = this.rows.get(id)
    if (entry === undefined || entry.disabled === options.disabled) return
    if (options.disabled === false && entry.moduleName.includes('__broken__')) {
      // Loader rolls back the failed enable (entry stays disabled).
      throw new Error('boom: plugin failed to load')
    }
    this.rows.set(id, {
      ...entry,
      disabled: options.disabled,
      phase: options.disabled ? null : 'active',
    })
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id)
  }

  async idle(): Promise<void> {
    // No real tree here: the loader is always idle.
  }

  view(id: string): LoaderEntryView | undefined {
    return this.rows.get(id)
  }
}

/** In-memory RecordsPort mirroring PluginRecordStore semantics. */
export class FakeRecords implements RecordsPort {
  private readonly byKey = new Map<string, PluginMarketRecord>()

  seed(key: string, partial: Partial<PluginMarketRecord> = {}): PluginMarketRecord {
    const record = makeRecord(key, partial)
    this.byKey.set(record.key, record)
    return record
  }

  async list(): Promise<PluginMarketRecord[]> {
    return [...this.byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  async get(key: PluginMarketKey): Promise<PluginMarketRecord | null> {
    return this.byKey.get(key) ?? null
  }

  async setEnabled(key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord> {
    const record = this.byKey.get(key)
    if (record === undefined) throw new Error(`no record ${key}`)
    const next = { ...record, enabled }
    this.byKey.set(key, next)
    return next
  }

  async remove(key: PluginMarketKey): Promise<boolean> {
    return this.byKey.delete(key)
  }
}

/** Removed-directory recording + throwing knobs. */
export class FakeRemover {
  readonly removed: string[] = []
  failNext = false

  async remove(directory: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('directory removal failed')
    }
    this.removed.push(directory)
  }
}

export interface Testbed {
  readonly records: FakeRecords
  readonly loader: FakeLoader
  readonly remover: FakeRemover
  readonly now: () => Date
  controller(): MarketPluginController
  deps(): MarketControllerDeps
}

/** Build a controller environment over fakes (module root `/repo`). */
export function testbed(clock: { now?: () => Date } = {}): Testbed {
  const records = new FakeRecords()
  const loader = new FakeLoader()
  const remover = new FakeRemover()
  const now = clock.now ?? (() => new Date(0))
  const deps = (): MarketControllerDeps => ({
    repositoryRoot: '/repo',
    records,
    loader,
    removeDirectory: (dir) => remover.remove(dir),
    protection: {
      isProtectedKey: (key) => isProtectedRecordKey(key),
      isSelfModule: (moduleName) => moduleName.includes('__self__'),
    },
    entryModuleOf: (record) => entryModuleNameFor(record),
    entryDirectoryOf: (record) => `/repo/${record.localDirName}`,
    now,
    logger: { warn: () => {}, error: () => {} },
  })
  return {
    records,
    loader,
    remover,
    now,
    controller: () => new MarketPluginController(deps()),
    deps,
  }
}

/** Canonical fake module name used by the testbed. */
export function entryModuleNameFor(record: PluginMarketRecord): string {
  return `file:///repo/${record.localDirName}/${record.entry ?? 'index.js'}`
}

/** Valid brand-free key helper for tests. */
export function key(raw: string): PluginMarketKey {
  return parsePluginKey(raw)
}

export function makeSource(repository = 'octocat/demo-plugin'): PluginMarketGithubSource {
  return { kind: 'github', repository, version: 'v1.0.0', commit: 'abc123' }
}

export function makeRecord(keyRaw: string, partial: Partial<PluginMarketRecord> = {}): PluginMarketRecord {
  const k = key(keyRaw)
  const source: PluginMarketSource = partial.source ?? makeSource()
  return {
    key: k,
    source,
    localDirName: partial.localDirName ?? 'checkout',
    entry: partial.entry === undefined ? null : partial.entry,
    installedAt: partial.installedAt ?? '2026-01-01T00:00:00.000Z',
    enabled: partial.enabled ?? false,
    trusted: partial.trusted ?? 'untrusted',
    trustedAt: partial.trustedAt ?? null,
  }
}

/**
 * Global activation log shared by every module copy of a demo fixture (native
 * loader imports and the vitest runner may cache separate module instances,
 * but they share one JS realm), so apply/unload cycles stay observable.
 */
export const DEMO_LOG_KEY = Symbol.for('dsh-plugin-market-demo-log')

/** Minimal fixture plugin source for on-disk demos (write to an .mjs file). */
export function demoPluginSource(pluginName: string, cordisImport: string): string {
  return [
    `import { Context } from ${JSON.stringify(cordisImport)}`,
    `export const name = ${JSON.stringify(pluginName)}`,
    'export const inject = []',
    'export const appliedCordisContext = Context',
    'export function apply(ctx) {',
    '  const log = globalThis[Symbol.for(\'dsh-plugin-market-demo-log\')]',
    "  log?.push({ kind: 'up', at: Date.now() })",
    "  ctx.effect(() => () => { log?.push({ kind: 'down', at: Date.now() }) })",
    '}',
    '',
  ].join('\n')
}

/** Shape guard mirroring plugin.Object for vitest typing. */
export type FixturePlugin = Plugin.Object