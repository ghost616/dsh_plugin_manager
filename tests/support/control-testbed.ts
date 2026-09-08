/**
 * Shared fakes for plugin-control-service specs: an in-memory record store, a
 * scripted loader adapter, and a controller-environment factory. Records are
 * built through the stable-key validator so branded keys flow through the
 * controller like real wire keys.
 */

import type { Plugin } from '@deepseek-ai/cordis'
import type {
  GitHubSearchPage,
  ManagedPluginPhase,
  PluginMarketGithubSource,
  PluginMarketKey,
  PluginMarketRecord,
  PluginPreviewOutcome,
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
import type { MarketRepository } from '../../src/host/market/index.ts'
import {
  MarketSourceOperations,
  type InstallerPort,
  type MarketSourceDeps,
  type PreviewEnginePort,
  type SearchEnginePort,
} from '../../src/host/control/source.ts'
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
  readonly engines: FakeEngines
  readonly now: () => Date
  /** Fake opened repository over {@link records}. */
  readonly repository: MarketRepository
  controller(): MarketPluginController
  deps(): MarketControllerDeps
}

/** Build a controller environment over fakes (module root `/repo`). */
export function testbed(clock: { now?: () => Date } = {}): Testbed {
  const records = new FakeRecords()
  const loader = new FakeLoader()
  const remover = new FakeRemover()
  const engines = new FakeEngines()
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
    engines,
    now,
    repository: fakeRepository(records),
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

/** A fake opened repository over an in-memory records store. */
export function fakeRepository(records: FakeRecords, root = '/repo'): MarketRepository {
  return {
    root,
    records,
    harnessLinks: { scopePath: `${root}/node_modules/@deepseek-ai`, links: [] },
    harnessVerified: null,
  }
}

/** Scriptable source engines for source-operation and channel specs. */
export class FakeEngines {
  searchResult: GitHubSearchPage = { totalCount: 0, items: [] }
  searchError: unknown = undefined
  searchCalls: { keywords?: string; perPage?: number }[] = []
  previewResult: PluginPreviewOutcome = {
    status: 'ready',
    summary: { name: 'demo-plugin', version: '1.0.0', dependencies: { dependencies: ['@deepseek-ai/cordis'], peerDependencies: [] } },
  }
  previewCalls: string[] = []
  installCalls: { repositoryRoot: string; key: string; repository: string; version: string | null }[] = []
  /** Returned record; built on demand unless preset. */
  installedRecord: PluginMarketRecord | null = null
  installError: unknown = undefined
  synced: PluginMarketRecord[] = []

  searchEngine: SearchEnginePort = {
    search: async (options) => {
      this.searchCalls.push(options)
      if (this.searchError !== undefined) throw this.searchError
      return this.searchResult
    },
  }

  previewEngine: PreviewEnginePort = {
    preview: async (repository) => {
      this.previewCalls.push(repository)
      return this.previewResult
    },
  }

  installer(records: FakeRecords): InstallerPort {
    return {
      install: async (input) => {
        this.installCalls.push(input)
        if (this.installError !== undefined) throw this.installError
        const record = this.installedRecord ?? makeRecord(input.key, {
          source: makeSource(input.repository),
          localDirName: input.key,
          entry: 'index.js',
          trusted: 'trusted',
          trustedAt: '2026-01-01T00:00:00.000Z',
        })
        records.seed(input.key, {
          ...record,
          key: record.key,
          source: record.source,
          localDirName: record.localDirName,
          entry: record.entry,
          enabled: false,
          trusted: 'trusted',
          trustedAt: record.trustedAt,
        })
        return { record, checkoutDir: `${input.repositoryRoot}/${input.key}` }
      },
    }
  }

  syncRecord: (record: PluginMarketRecord) => Promise<void> = async (record) => {
    this.synced.push(record)
  }
}

/** Build a MarketSourceOperations over a repository (null ⇒ idle). */
export function makeSourceOps(
  repository: MarketRepository | null,
  records: FakeRecords,
  engines: FakeEngines = new FakeEngines(),
  options: {
    now?: () => Date
    confirmTtlMs?: number
    isProtectedKey?: (key: string) => boolean
    isSelfModule?: (moduleName: string) => boolean
  } = {},
): MarketSourceOperations {
  const deps: MarketSourceDeps = {
    repository: () => repository,
    searchEngine: engines.searchEngine,
    previewEngine: engines.previewEngine,
    installer: () => engines.installer(records),
    protection: {
      isProtectedKey: options.isProtectedKey ?? isProtectedRecordKey,
      isSelfModule: options.isSelfModule ?? (() => false),
    },
    syncRecord: engines.syncRecord,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.confirmTtlMs === undefined ? {} : { confirmTtlMs: options.confirmTtlMs }),
    logger: { warn: () => {}, error: () => {} },
  }
  return new MarketSourceOperations(deps)
}

/** Controller env of the source specs (same shape as {@link testbed}). */
export function sourceTestbed(): {
  records: FakeRecords
  repository: MarketRepository
  engines: FakeEngines
  now(): Date
  source(clock?: { now?: () => Date }): MarketSourceOperations
} {
  const records = new FakeRecords()
  const engines = new FakeEngines()
  return {
    records,
    repository: fakeRepository(records),
    engines,
    now: () => new Date(0),
    source: (clock = {}) => makeSourceOps(fakeRepository(records), records, engines, clock),
  }
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