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
  PluginMarketClassification,
  PluginMarketGithubSource,
  PluginMarketKey,
  PluginMarketRecord,
  PluginPreviewOutcome,
} from '../../src/types.ts'
import { parsePluginKey } from '../../src/host/market/keys.ts'
import type { GitHubRepoMeta } from '../../src/host/market/github.ts'
import type { PluginAnalysisDistribution } from '../../src/host/market/analyze.ts'
import { refSegOf } from '../../src/host/market/paths.ts'
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
  type InstallAnalysisEngine,
  type InstalledPluginFacts,
  type InstallerPort,
  type MarketSourceDeps,
  type PreviewEnginePort,
  type RepositoryDetailPort,
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
  installCalls: {
    repositoryRoot: string
    key: string
    repository: string
    version: string | null
    refKind?: 'branch' | 'tag'
    classification?: PluginMarketClassification
  }[] = []
  /** Returned record; built on demand unless preset. */
  installedRecord: PluginMarketRecord | null = null
  /**
   * Runnable entry the fake checkout carries, or null for an entry-less
   * checkout (skills pack / not-built plugin). The host rule under test is
   * "the entry probe wins", so this — not the reviewed classification —
   * decides the filed tag.
   */
  installedEntry: string | null = 'index.js'
  /** Facts the fake installer reported back on the last install call. */
  installedFacts: InstalledPluginFacts = {
    classification: 'plugin',
    entry: 'index.js',
    entryNote: null,
    dependenciesInstalled: true,
  }
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

  /** Detail-engine script: metadata/branches/tags/readme stubs + recording. */
  detailCalls: { kind: 'meta' | 'branches' | 'tags' | 'readme'; slug: string }[] = []
  metaResult: GitHubRepoMeta = {
    slug: 'octocat/demo-plugin',
    name: 'demo-plugin',
    description: 'a dsh plugin',
    stars: 12,
    updatedAt: '2026-01-01T00:00:00.000Z',
    url: 'https://github.com/octocat/demo-plugin',
    cloneUrl: 'https://github.com/octocat/demo-plugin.git',
    defaultBranch: 'main',
  }
  metaError: unknown = undefined
  branchesResult: readonly string[] = ['main']
  branchesError: unknown = undefined
  tagsResult: readonly string[] = ['v1.0.0']
  tagsError: unknown = undefined
  readmeResult: string | null = '# demo plugin\n'
  readmeError: unknown = undefined

  detailEngine: RepositoryDetailPort = {
    repositoryMeta: async (slug) => {
      this.detailCalls.push({ kind: 'meta', slug })
      if (this.metaError !== undefined) throw this.metaError
      return { ...this.metaResult, slug }
    },
    branches: async (slug) => {
      this.detailCalls.push({ kind: 'branches', slug })
      if (this.branchesError !== undefined) throw this.branchesError
      return this.branchesResult
    },
    tags: async (slug) => {
      this.detailCalls.push({ kind: 'tags', slug })
      if (this.tagsError !== undefined) throw this.tagsError
      return this.tagsResult
    },
    readme: async (slug) => {
      this.detailCalls.push({ kind: 'readme', slug })
      if (this.readmeError !== undefined) throw this.readmeError
      return this.readmeResult
    },
  }

  installer(records: FakeRecords): InstallerPort {
    return {
      install: async (input) => {
        this.installCalls.push(input)
        if (this.installError !== undefined) throw this.installError
        // Mirror the host pipeline's staging rule (entry probe wins): a checkout
        // carrying a runnable entry is ALWAYS filed `plugin`, whatever the
        // review classified it as. The reviewed classification only decides the
        // tag of an entry-less checkout (skills, else other).
        const entry = this.installedEntry
        const classification: PluginMarketClassification = entry === null
          ? (input.classification === 'skills' ? 'skills' : 'other')
          : 'plugin'
        const entryNote = entry === null ? 'The checkout has no runnable plugin entry.' : null
        // v2 ref installs register the per-tuple layout `<owner>/<repo>/<kind>/<refSeg>`
        // and a source carrying refKind; legacy installs keep the key as the
        // single-segment checkout and no ref kind (old-record compatible).
        const v2DirName = input.refKind === undefined ? null : refDirName(input.repository, input.refKind, input.version)
        const record = this.installedRecord ?? makeRecord(input.key, {
          source: input.refKind === undefined
            ? makeSource(input.repository)
            : { kind: 'github', repository: input.repository, refKind: input.refKind, version: input.version, commit: null },
          localDirName: v2DirName ?? input.key,
          entry,
          classification,
          trusted: 'trusted',
          trustedAt: '2026-01-01T00:00:00.000Z',
        })
        records.seed(input.key, {
          ...record,
          key: record.key,
          source: record.source,
          localDirName: record.localDirName,
          entry: record.entry,
          classification: record.classification,
          enabled: false,
          trusted: 'trusted',
          trustedAt: record.trustedAt,
        })
        this.installedFacts = {
          classification: record.classification ?? 'plugin',
          entry: record.entry,
          entryNote,
          dependenciesInstalled: entry !== null,
        }
        return {
          record,
          checkoutDir: `${input.repositoryRoot}/${v2DirName ?? input.key}`,
          ...this.installedFacts,
        }
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
    /** Optional smart-install analysis engine (default: none → llm-unconfigured). */
    analysis?: InstallAnalysisEngine
    /**
     * Optional preview-time entry probe (production wires none: the remote
     * preview cannot inspect the checkout).
     */
    analysisEntryProbe?: (repository: string, relativeEntry: string) => boolean | Promise<boolean>
  } = {},
): MarketSourceOperations {
  const deps: MarketSourceDeps = {
    repository: () => repository,
    searchEngine: engines.searchEngine,
    detailEngine: engines.detailEngine,
    previewEngine: engines.previewEngine,
    installer: () => engines.installer(records),
    protection: {
      isProtectedKey: options.isProtectedKey ?? isProtectedRecordKey,
      isSelfModule: options.isSelfModule ?? (() => false),
    },
    syncRecord: engines.syncRecord,
    ...(options.analysis === undefined ? {} : { analysis: options.analysis }),
    ...(options.analysisEntryProbe === undefined ? {} : { analysisEntryProbe: options.analysisEntryProbe }),
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

/** One analysis call recorded by {@link fakeAnalysisEngine}. */
export interface FakeAnalysisCall {
  readonly repository: string
  /** Whether the caller supplied the preview-time entry probe. */
  readonly probed: boolean
  /** Entry names the probe was asked about. */
  readonly probedEntries: string[]
}

/**
 * Scriptable smart-install analysis engine with a call recorder. A scripted
 * `result` is returned as-is; a scripted `probeDistribution` is answered after
 * consulting the request's `hasFile` probe, mirroring what the real host
 * analyzer does with it (a plugin answer whose entry is absent folds into
 * `other` + `buildRequired`).
 */
export function fakeAnalysisEngine(script: {
  /**
   * Distribution the engine answers with; `null` (the default) means the model
   * judged the checkout a standard installable plugin.
   */
  result?: PluginAnalysisDistribution | null
  /** Answer derived from the request's entry probe (see the factory docs). */
  probeDistribution?: {
    readonly classification: PluginMarketClassification
    readonly entryHint: string
    readonly reason: string
  }
  /** Throw this error on the next call instead of returning. */
  error?: unknown
} = {}): InstallAnalysisEngine & { readonly calls: FakeAnalysisCall[] } {
  const calls: FakeAnalysisCall[] = []
  return {
    calls,
    async analyze(request) {
      const probedEntries: string[] = []
      const hasFile = request.hasFile
      const probedScript = script.probeDistribution
      let probed: boolean | undefined
      if (hasFile !== undefined && probedScript !== undefined) {
        probedEntries.push(probedScript.entryHint)
        probed = await hasFile(probedScript.entryHint)
      }
      calls.push({ repository: request.repository, probed: hasFile !== undefined, probedEntries })
      if (script.error !== undefined) {
        const error = script.error
        script.error = undefined
        throw error
      }
      if (probedScript !== undefined) {
        return probed === false
          ? fakeDistribution({
            classification: 'other',
            entry: null,
            entryHint: probedScript.entryHint,
            reason: probedScript.reason,
            buildRequired: true,
          })
          : fakeDistribution({
            classification: probedScript.classification,
            entry: probedScript.entryHint,
            entryHint: probedScript.entryHint,
            reason: probedScript.reason,
          })
      }
      return script.result ?? null
    },
  }
}

/**
 * One classification distribution shaped like the host analyzer's answer (see
 * plugin-market-host analyze.ts `resolveAnalysisDistribution`).
 */
export function fakeDistribution(
  partial: Partial<PluginAnalysisDistribution> & Pick<PluginAnalysisDistribution, 'classification'>,
): PluginAnalysisDistribution {
  return {
    classification: partial.classification,
    entry: partial.entry === undefined ? (partial.classification === 'plugin' ? 'index.js' : null) : partial.entry,
    entryHint: partial.entryHint ?? null,
    reason: partial.reason ?? 'the model classified this checkout',
    buildRequired: partial.buildRequired ?? false,
  }
}

/**
 * v2 per-ref checkout dir `<owner>/<repo>/<kind>/<refSeg>` — mirrors the host
 * installer's destination so fake records line up with real v2 records.
 */
export function refDirName(
  repository: string,
  refKind: 'branch' | 'tag',
  ref: string | null,
): string | null {
  if (ref === null || ref.length === 0) return null
  const slash = repository.indexOf('/')
  const owner = repository.slice(0, slash)
  const repo = repository.slice(slash + 1)
  const refSeg = refSegOf(ref)
  return refSeg === null ? null : `${owner}/${repo}/${refKind}/${refSeg}`
}

export function makeRecord(keyRaw: string, partial: Partial<PluginMarketRecord> = {}): PluginMarketRecord {
  const k = key(keyRaw)
  const source: PluginMarketSource = partial.source ?? makeSource()
  return {
    key: k,
    source,
    localDirName: partial.localDirName ?? 'checkout',
    entry: partial.entry === undefined ? null : partial.entry,
    ...(partial.classification === undefined ? {} : { classification: partial.classification }),
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