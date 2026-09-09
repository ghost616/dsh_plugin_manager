/**
 * Client-side fakes for plugin-market-ui specs.
 *
 * The dsh platform packages (dsh-client-ui-slots / dsh-client-ui-renderer /
 * dsh-client-locale) are runtime module-table rows of the shipped web shell and
 * are not installed in this repo, so the assembly spec drives the observable
 * platform contract with small functional replicas: a LocaleRuntime-like
 * dictionary runtime and a SlotRegistry-like registry (root slot seeded,
 * register/inject/children-declaration lifecycle, declaration epochs). Only
 * the surface the plugin under test consumes is modelled.
 */

import { vi } from 'vitest'
import type {
  ManagedPluginPhase,
  ManagedPluginList,
  ManagedPluginView,
  PluginMarketRecord,
} from '../../src/types.ts'
import { en, zh, type MarketManageLocaleKey } from '../../src/client/locales.ts'

/** Languages this tab's dictionaries register. */
export type FakeLocale = 'zh' | 'en'

/** Translate with `{name}`-style interpolation over one dictionary. */
export function makeTranslator(language: FakeLocale = 'zh') {
  const dict = language === 'zh' ? zh : en
  return (key: MarketManageLocaleKey | (string & {}), params?: Record<string, unknown>): string => {
    const template = dict[key as MarketManageLocaleKey] ?? key
    if (params === undefined) return template
    let text = template
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
    return text
  }
}

/** Fake of the dsh LocaleRuntime surface this tab consumes. */
export class FakeLocaleRuntime {
  language: FakeLocale = 'zh'
  revision = 0
  private readonly dicts = new Map<string, Partial<Record<FakeLocale, Record<string, string>>>>()
  private readonly listeners = new Set<() => void>()

  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  register(ns: string, locale: FakeLocale, dict: Record<string, string>): () => void
  register(ns: string, arg: Record<string, string> | { zh: Record<string, string>; en: Record<string, string> }, dict?: Record<string, string>): () => void {
    const entry = this.dicts.get(ns) ?? {}
    if (dict !== undefined && typeof arg === 'string') {
      entry[arg as FakeLocale] = dict
    } else {
      const pair = arg as { zh: Record<string, string>; en: Record<string, string> }
      entry.zh = pair.zh
      entry.en = pair.en
    }
    this.dicts.set(ns, entry)
    this.bump()
    const present = this.dicts.get(ns)
    return () => {
      if (present === undefined || this.dicts.get(ns) !== present) return
      this.dicts.delete(ns)
      this.bump()
    }
  }

  bind(ns: string): (key: string, params?: Record<string, unknown>) => string {
    return (key, params) => this.resolve(ns, key, params)
  }

  resolve(ns: string, key: string, params?: Record<string, unknown>): string {
    const entry = this.dicts.get(ns)
    const template = entry?.[this.language]?.[key] ?? key
    if (params === undefined) return template
    let text = template
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value))
    }
    return text
  }

  /** Switch the active language (mirrors LocaleRuntime.setLocale). */
  setLocale(language: FakeLocale): void {
    if (this.language === language) return
    this.language = language
    this.bump()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private bump(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }
}

/** One stored registration, mirroring ui-slots StoredEntry surface. */
export interface FakeStoredEntry {
  component: unknown
  options: { id?: string; order?: number; label?: string | (() => string) }
  locale?: string
  inject?: () => Record<string, unknown>
  children?: Readonly<Record<string, { kind: string; scope: string }>>
}

interface SlotRecord {
  spec: { kind: string; scope: string } | undefined
  parent: string | undefined
  epoch: number
  entries: FakeStoredEntry[]
  version: number
  listeners: Set<() => void>
  declarationListeners: Set<() => void>
}

type RegisterOptions = {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
  locale?: string
  inject?: () => Record<string, unknown>
  children?: Record<string, { kind: 'list' | 'single' | 'keyed' | 'chain'; scope: string }>
}

interface PendingInjection {
  stopped: boolean
  active: (() => void) | undefined
  unsubscribe: () => void
  reconcile: () => void
}

/** Functional replica of the SlotRegistry surface this tab consumes. */
export class FakeSlotRegistry {
  private readonly records = new Map<string, SlotRecord>()
  private readonly injections = new Set<PendingInjection>()

  constructor() {
    this.records.set('root', {
      spec: { kind: 'single', scope: 'root' },
      parent: undefined,
      epoch: 1,
      entries: [],
      version: 0,
      listeners: new Set(),
      declarationListeners: new Set(),
    })
  }

  register(options: RegisterOptions, component: unknown): () => void {
    const rec = this.recordOf(options.name)
    if (rec.spec === undefined) {
      throw new Error(`slot "${options.name}" is not declared`)
    }
    const entry: FakeStoredEntry = {
      component,
      options: {
        ...(options.id !== undefined ? { id: options.id } : {}),
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
      },
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      ...(options.inject !== undefined ? { inject: options.inject } : {}),
      ...(options.children !== undefined ? { children: options.children } : {}),
    }
    const next = [...rec.entries, entry]
    next.sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    rec.entries = next
    this.markDirty(options.name)

    if (options.children !== undefined) {
      const children = Object.entries(options.children)
      for (const [childName] of children) {
        const child = this.recordOf(childName)
        if (child.spec !== undefined) {
          throw new Error(`slot "${childName}" is already declared`)
        }
      }
      for (const [childName, childSpec] of children) {
        const child = this.recordOf(childName)
        child.spec = childSpec as { kind: string; scope: string }
        child.parent = options.name
        child.epoch += 1
        this.markDirty(childName)
      }
      for (const [childName] of children) {
        this.notifyDeclaration(childName)
      }
    }

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (!rec.entries.includes(entry)) return
      rec.entries = rec.entries.filter(candidate => candidate !== entry)
      this.markDirty(options.name)
      this.collapseChildren(options.name)
    }
  }

  /** Wait for one slot's declaration lifetime, then run the callback. */
  inject(name: string, callback: () => (() => void) | Iterable<() => void>): () => void {
    const rec = this.recordOf(name)
    const pending: PendingInjection = {
      stopped: false,
      active: undefined,
      unsubscribe: () => {},
      reconcile: () => {},
    }
    pending.reconcile = () => {
      if (pending.stopped) return
      if (pending.active !== undefined) {
        const dispose = pending.active
        pending.active = undefined
        dispose()
      }
      if (rec.spec === undefined) return
      const result = callback()
      const disposers = typeof result === 'function'
        ? [result]
        : [...result]
      pending.active = () => {
        for (const disposer of [...disposers].reverse()) disposer()
      }
    }
    const changed = (): void => { pending.reconcile() }
    rec.declarationListeners.add(changed)
    pending.unsubscribe = () => { rec.declarationListeners.delete(changed) }
    this.injections.add(pending)
    pending.reconcile()
    return () => {
      if (pending.stopped) return
      pending.stopped = true
      pending.unsubscribe()
      if (pending.active !== undefined) {
        const dispose = pending.active
        pending.active = undefined
        dispose()
      }
      this.injections.delete(pending)
    }
  }

  entries(name: string): readonly FakeStoredEntry[] {
    return this.records.get(name)?.entries ?? []
  }

  spec(name: string): { kind: string; scope: string } | undefined {
    return this.records.get(name)?.spec
  }

  getVersion(name: string): number {
    return this.records.get(name)?.version ?? 0
  }

  subscribe(name: string, listener: () => void): () => void {
    const rec = this.recordOf(name)
    rec.listeners.add(listener)
    return () => { rec.listeners.delete(listener) }
  }

  /** Number of live inject waits (assertions on deferred registration). */
  pendingInjections(): number {
    return this.injections.size
  }

  /** Dispose every pending injection (models plugin-fiber unload collection). */
  disposeInjections(): void {
    for (const pending of [...this.injections]) {
      pending.stopped = true
      pending.unsubscribe()
      if (pending.active !== undefined) {
        const dispose = pending.active
        pending.active = undefined
        dispose()
      }
    }
    this.injections.clear()
  }

  private recordOf(name: string): SlotRecord {
    let rec = this.records.get(name)
    if (rec === undefined) {
      rec = {
        spec: undefined,
        parent: undefined,
        epoch: 0,
        entries: [],
        version: 0,
        listeners: new Set(),
        declarationListeners: new Set(),
      }
      this.records.set(name, rec)
    }
    return rec
  }

  /** Collapse slots declared by the given entry (removal cascade). */
  private collapseChildren(owner: string): void {
    for (const [name, rec] of [...this.records]) {
      if (rec.parent !== owner || rec.spec === undefined) continue
      this.collapse(name)
    }
  }

  private collapse(name: string): void {
    const rec = this.records.get(name)
    if (rec === undefined || rec.spec === undefined) return
    for (const [child, childRec] of [...this.records]) {
      if (childRec.parent === name) this.collapse(child)
    }
    rec.spec = undefined
    rec.parent = undefined
    rec.entries = []
    rec.epoch += 1
    this.markDirty(name)
    this.notifyDeclaration(name)
  }

  private markDirty(name: string): void {
    const rec = this.records.get(name)
    if (rec === undefined) return
    rec.version += 1
    for (const listener of [...rec.listeners]) listener()
  }

  private notifyDeclaration(name: string): void {
    const rec = this.records.get(name)
    if (rec === undefined) return
    for (const listener of [...rec.declarationListeners]) listener()
  }
}

/** Resolve a possibly-thunked slot label (ui-slots resolveSlotLabel replica). */
export function resolveSlotLabel(label: string | (() => string) | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

/* ------------------------------------------------------------------------ */
/* Managed-view fixtures (typed at the boundary only; tests are transpiled) */
/* ------------------------------------------------------------------------ */

export interface ManagedViewSeed {
  key: string
  repository: string
  enabled?: boolean
  phase?: ManagedPluginPhase
  lastError?: string | null
  /** Pinned branch/tag of the record; null models a legacy default-branch install. */
  version?: string | null
}

/** Build one ManagedPluginView from a compact seed. */
export function makeView(seed: ManagedViewSeed): ManagedPluginView {
  const enabled = seed.enabled ?? false
  const phase = seed.phase ?? (enabled ? 'active' : null)
  return {
    key: seed.key as PluginMarketRecord['key'],
    record: {
      key: seed.key as PluginMarketRecord['key'],
      source: {
        kind: 'github',
        repository: seed.repository,
        version: seed.version === undefined ? 'v1.0.0' : seed.version,
        commit: null,
      },
      localDirName: `gh-${seed.key}`,
      entry: null,
      installedAt: '2026-01-01T00:00:00.000Z',
      enabled,
      trusted: 'trusted',
      trustedAt: null,
    },
    runtime: {
      moduleName: `file:///repo/${seed.key}/index.js`,
      disabled: !enabled,
      phase,
      lastError: seed.lastError === undefined ? null : seed.lastError,
    },
  }
}

/** Build the wire list payload of several views. */
export function makeList(seeds: readonly ManagedViewSeed[]): ManagedPluginList {
  return { entries: seeds.map(makeView) }
}
/* ------------------------------------------------------------------------ */
/* M1 page fixtures (search / status / install review / outcomes)           */
/* ------------------------------------------------------------------------ */

export interface SearchItemSeed {
  repository: string
  name?: string
  description?: string | null
  stars?: number
  updatedAt?: string | null
  url?: string
}

/** Build one GitHub search result summary from a compact seed. */
export function makeRepoSummary(seed: SearchItemSeed) {
  const fallbackUrl = `https://github.com/${seed.repository}`
  return {
    repository: seed.repository,
    name: seed.name ?? seed.repository.split('/')[1] ?? seed.repository,
    description: seed.description ?? 'a dsh plugin',
    stars: seed.stars ?? 0,
    updatedAt: seed.updatedAt ?? '2026-01-01T00:00:00.000Z',
    url: seed.url ?? fallbackUrl,
    cloneUrl: `${fallbackUrl}.git`,
  }
}

/** Build a search page over compact seeds. */
export function makeSearchPage(items: SearchItemSeed[]) {
  return { totalCount: items.length, items: items.map(makeRepoSummary) }
}

export interface RepositoryDetailSeed {
  repository: string
  name?: string
  description?: string | null
  stars?: number
  updatedAt?: string | null
  url?: string
  defaultBranch?: string
  branches?: string[]
  tags?: string[]
  /** Raw README markdown; undefined = a README exists with a default body,
   *  null = the repository has no README. */
  readme?: string | null
}

/** Build a RepositoryDetail-shaped fixture for one repository. */
export function makeRepositoryDetail(seed: RepositoryDetailSeed) {
  const fallbackUrl = `https://github.com/${seed.repository}`
  const defaultBranch = seed.defaultBranch ?? 'main'
  const branches = seed.branches ?? [defaultBranch]
  return {
    repository: seed.repository,
    name: seed.name ?? seed.repository.split('/')[1] ?? seed.repository,
    description: seed.description ?? 'a dsh plugin',
    stars: seed.stars ?? 0,
    updatedAt: seed.updatedAt ?? '2026-01-01T00:00:00.000Z',
    url: seed.url ?? fallbackUrl,
    cloneUrl: `${fallbackUrl}.git`,
    defaultBranch,
    branches,
    tags: seed.tags ?? [],
    readme: seed.readme === undefined ? '# Overview' : seed.readme,
  }
}

/** Build market activation status. */
export function makeStatus(configured: boolean, repositoryPath: string | null = configured ? '/repo' : null) {
  return { configured, repositoryPath }
}

export interface InstallReviewSeed {
  repository: string
  exists?: boolean
  degraded?: boolean
  dependencies?: string[]
  peerDependencies?: string[]
  /** Version resolved by the preview (branch/tag name when pinned). */
  version?: string
}

/** Build a PluginInstallReview-shaped fixture for one repository. */
export function makeInstallReview(seed: InstallReviewSeed) {
  const slug = seed.repository
  const key = `gh-${slug.replace('/', '-')}`
  const summary = {
    name: slug.split('/')[1] ?? slug,
    version: seed.version ?? '1.0.0',
    dependencies: {
      dependencies: seed.dependencies ?? ['@deepseek-ai/cordis'],
      peerDependencies: seed.peerDependencies ?? [],
    },
  }
  const preview = seed.degraded === true
    ? { status: 'degraded', summary, reason: 'manifest unreadable', code: 'github/bad-response' }
    : { status: 'ready', summary }
  return {
    repository: slug,
    key,
    preview,
    exists: seed.exists === true,
    overwrite: seed.exists === true,
    existing: null,
    confirmToken: `token-${slug}`,
    expiresAt: '2026-01-02T00:00:00.000Z',
  }
}

/** Build a PluginInstallOutcome-shaped fixture. */
export function makeInstallOutcome(seed: { repository: string; overwritten?: boolean; version?: string }) {
  const key = `gh-${seed.repository.replace('/', '-')}`
  return {
    key,
    overwritten: seed.overwritten === true,
    record: makeView({
      key,
      repository: seed.repository,
      version: seed.version === undefined ? 'v1.0.0' : seed.version,
    }).record,
    checkoutDir: `/repo/${key}`,
  }
}

/** Build a removal request fixture. */
export function makeRemoveRequest(key: string, token = 'rm-token') {
  return { key, token, expiresAt: '2026-01-02T00:00:00.000Z' }
}

/** Default prop mocks for the full settings page (each override-able). */
export function managePageHarness(overrides: Record<string, unknown> = {}) {
  const mocks = {
    status: vi.fn(async () => makeStatus(true)),
    list: vi.fn(async () => makeList([])),
    setEnabled: vi.fn(async () => { throw new Error('unused default setEnabled') }),
    requestRemove: vi.fn(async () => { throw new Error('unused default requestRemove') }),
    confirmRemove: vi.fn(async () => { throw new Error('unused default confirmRemove') }),
    search: vi.fn(async () => makeSearchPage([])),
    repositoryDetail: vi.fn(async () => { throw new Error('unused default repositoryDetail') }),
    previewInstall: vi.fn(async (repository: string) => makeInstallReview({ repository })),
    install: vi.fn(async () => { throw new Error('unused default install') }),
  }
  const props = {
    t: makeTranslator('zh'),
    ...mocks,
    ...overrides,
  }
  return { props, mocks }
}
