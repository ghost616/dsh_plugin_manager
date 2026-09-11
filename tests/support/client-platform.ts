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
  GitHubTokenSource,
  GitHubTokenStatus,
  GitHubTokenUpdateResult,
  GithubRefKind,
  ManagedPluginPhase,
  ManagedPluginList,
  ManagedPluginView,
  MarketCheckoutKind,
  MarketInstallNote,
  PluginInstallOutcome,
  PluginInstallReview,
  PluginMarketClassification,
  PluginMarketRecord,
  PluginMarketKey,
  PluginPreviewOutcome,
} from '../../src/types.ts'
import type { ManagePluginsTabInjected, ManagePluginsTabProps } from '../../src/client/ManagePluginsTab.tsx'
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
  register(ns: string, arg: FakeLocale | { zh: Record<string, string>; en: Record<string, string> }, dict?: Record<string, string>): () => void {
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
  /** V2 ref kind of the pinned ref; absent = legacy record without ref metadata. */
  refKind?: GithubRefKind
  /** Persisted classification tag; absent = the documented `plugin` default. */
  classification?: PluginMarketClassification
  /** Runnable entry of the checkout; defaults from the classification
   *  (`index.js` for a plugin, null for a skills/other checkout). */
  entry?: string | null
}

/** Build one ManagedPluginView from a compact seed. */
export function makeView(seed: ManagedViewSeed): ManagedPluginView {
  const enabled = seed.enabled ?? false
  const phase = seed.phase ?? (enabled ? 'active' : null)
  const classification: PluginMarketClassification = seed.classification ?? 'plugin'
  const entry = seed.entry === undefined
    ? (classification === 'plugin' ? 'index.js' : null)
    : seed.entry
  return {
    key: seed.key as PluginMarketRecord['key'],
    record: {
      key: seed.key as PluginMarketRecord['key'],
      source: {
        kind: 'github',
        repository: seed.repository,
        version: seed.version === undefined ? 'v1.0.0' : seed.version,
        commit: null,
        ...(seed.refKind === undefined ? {} : { refKind: seed.refKind }),
      },
      localDirName: `gh-${seed.key}`,
      entry,
      classification,
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
    // Mirrors the control service's load gate: only a `plugin`-classified
    // record with a resolved entry can ever be registered.
    loadable: classification === 'plugin' && entry !== null,
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

/**
 * Spread-time helper for the exactOptionalPropertyTypes fixtures below: an
 * optional property is either present with a real value or absent entirely,
 * never present-and-`undefined`.
 */
function note<T extends object>(value: T | undefined): T | Record<string, never> {
  return value === undefined ? {} : value
}

export interface InstallReviewSeed {
  repository: string
  exists?: boolean
  degraded?: boolean
  dependencies?: string[]
  peerDependencies?: string[]
  /** Version resolved by the preview (branch/tag name when pinned). */
  version?: string
  /** Classification the review predicts the download will be filed under. */
  classification?: PluginMarketClassification
  /** Extra analyzer explanation shown under the classification line. */
  entryNote?: string
  /** Structured, localizable note of the review (host-authored kinds only). */
  note?: MarketInstallNote
  /** Whether the checkout needs a build before it can be enabled. */
  buildRequired?: boolean
  /** Smart-analysis verdict the review carries (no longer a refusal). */
  analysis?: { readonly kind: MarketCheckoutKind; readonly reason: string }
}

/** Build a PluginInstallReview-shaped fixture for one repository. */
export function makeInstallReview(seed: InstallReviewSeed): PluginInstallReview {
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
  const preview: PluginPreviewOutcome = seed.degraded === true
    ? { status: 'degraded', summary, reason: 'manifest unreadable', code: 'github/bad-response' }
    : { status: 'ready', summary }
  // A skills-shaped analysis files `skills`; every other non-plugin kind folds
  // into `other` (the host analyzer's own vocabulary mapping).
  const classification = seed.classification
    ?? (seed.analysis === undefined
      ? 'plugin'
      : seed.analysis.kind === 'skills' ? 'skills' : 'other')
  return {
    repository: slug,
    key: key as PluginMarketKey,
    preview,
    exists: seed.exists === true,
    overwrite: seed.exists === true,
    existing: null,
    confirmToken: `token-${slug}`,
    expiresAt: '2026-01-02T00:00:00.000Z',
    classification,
    ...(seed.buildRequired === true ? { buildRequired: true } : {}),
    ...note(seed.entryNote === undefined ? undefined : { entryNote: seed.entryNote }),
    ...note(seed.note === undefined ? undefined : { note: seed.note }),
    // The review carries the host's non-installable analysis verdict shape.
    ...note(seed.analysis === undefined
      ? undefined
      : { analysis: { installable: false as const, kind: seed.analysis.kind, reason: seed.analysis.reason } }),
  }
}

/** Build a PluginInstallOutcome-shaped fixture. */
export function makeInstallOutcome(seed: { repository: string; overwritten?: boolean; version?: string }): PluginInstallOutcome {
  const key = `gh-${seed.repository.replace('/', '-')}`
  return {
    key: key as PluginMarketKey,
    overwritten: seed.overwritten === true,
    record: makeView({
      key,
      repository: seed.repository,
      version: seed.version === undefined ? 'v1.0.0' : seed.version,
    }).record,
    checkoutDir: `/repo/${key}`,
  }
}

/** Build a DownloadClassification verdict fixture (phase 2 answer). */
export function makeVerdict(seed: {
  classification?: PluginMarketClassification
  outcome?: 'classified' | 'unclassified' | 'failed'
  reason?: string
  errorCode?: string
  entryPresent?: boolean | null
  entryHint?: string | null
} = {}) {
  const outcome = seed.outcome ?? 'classified'
  const classification = seed.classification
    ?? (outcome === 'classified' ? 'plugin' : 'other')
  return {
    outcome,
    classification,
    reason: seed.reason ?? `model says ${classification}`,
    unclassified: outcome !== 'classified',
    entryPresent: seed.entryPresent === undefined ? null : seed.entryPresent,
    entryHint: seed.entryHint === undefined ? null : seed.entryHint,
    ...(seed.errorCode === undefined ? {} : { errorCode: seed.errorCode }),
  }
}

/** Build the DownloadPreparation answer of phase 1 (sources cloned). */
export function makePreparation(seed: {
  repository: string
  token?: string
  version?: string | null
  refKind?: GithubRefKind
  overwrite?: boolean
} = { repository: 'acme/helper' }) {
  const token = seed.token ?? `dl-${seed.repository.replace('/', '-')}`
  return {
    token,
    key: `gh-${seed.repository.replace('/', '-')}` as PluginMarketKey,
    repository: seed.repository,
    ...(seed.refKind === undefined ? {} : { refKind: seed.refKind }),
    ref: seed.version === undefined ? 'v1.0.0' : seed.version,
    localDirName: `gh-${seed.repository.replace('/', '-')}`,
    commit: '0123456789abcdef0123456789abcdef01234567',
    startedAt: '2026-01-01T00:00:00.000Z',
    state: 'prepared' as const,
    overwrite: seed.overwrite === true,
  }
}

/** Build the DownloadCommit answer of phase 3 (swapped in + filed). */
export function makeCommit(seed: {
  repository: string
  token?: string
  classification?: PluginMarketClassification
  version?: string | null
  refKind?: GithubRefKind
  overwritten?: boolean
  entry?: string | null
} = { repository: 'acme/helper' }) {
  const key = `gh-${seed.repository.replace('/', '-')}`
  const record = makeView({
    key,
    repository: seed.repository,
    version: seed.version === undefined ? 'v1.0.0' : seed.version,
    ...(seed.refKind === undefined ? {} : { refKind: seed.refKind }),
    ...(seed.classification === undefined ? {} : { classification: seed.classification }),
    entry: seed.entry === undefined ? null : seed.entry,
  }).record
  return {
    key: key as PluginMarketKey,
    overwritten: seed.overwritten === true,
    record,
    checkoutDir: `/repo/${key}`,
    classification: seed.classification ?? 'plugin',
    entry: seed.entry === undefined ? null : seed.entry,
    // The download path NEVER installs dependencies.
    dependenciesInstalled: false as const,
    note: null,
  }
}

/** Build a removal request fixture. */
export function makeRemoveRequest(key: string, token = 'rm-token') {
  return { key, token, expiresAt: '2026-01-02T00:00:00.000Z' }
}

/* ------------------------------------------------------------------------ */
/* Access-token fixtures (credential seam)                                  */
/* ------------------------------------------------------------------------ */

export interface TokenStatusSeed {
  /** Whether the effective reference currently resolves to a value. */
  configured?: boolean
  /** Layer supplying the token; omitted = configured through an unnamed layer. */
  source?: GitHubTokenSource
  /** Whether the active provider can write the effective reference. */
  writable?: boolean
  /** Effective reference name (the wire carries the plain string). */
  ref?: string
}

/**
 * Build one GitHubTokenStatus-shaped fixture.
 *
 * The shape is the SHARED contract from `src/types.ts`: only `ref` differs at
 * the type level, because that face types it as the credential seam's branded
 * `CredentialRef` while the wire carries the plain string the brand wraps. The
 * brand is a compile-time phantom with no runtime marker (the seam's own wire
 * rule), so a wire fixture is a structural object plus that one assertion —
 * exactly how the browser half's channel face transports it.
 */
export function makeTokenStatus(seed: TokenStatusSeed = {}): GitHubTokenStatus {
  return {
    configured: seed.configured ?? false,
    ...(seed.source === undefined ? {} : { source: seed.source }),
    // An unconfigured status is writable by default (the head reference can be
    // written); the read-only launch environment is the explicit `false`.
    writable: seed.writable ?? true,
    ref: (seed.ref ?? 'DSH_GITHUB_TOKEN') as GitHubTokenStatus['ref'],
  }
}

/** Build one GitHubTokenUpdateResult-shaped wire fixture. */
export function makeTokenUpdate(
  seed: TokenStatusSeed = {},
  cacheCleared = true,
): GitHubTokenUpdateResult {
  return { status: makeTokenStatus(seed), cacheCleared }
}

/**
 * Default prop mocks for the full settings page (each override-able).
 *
 * The download defaults model the STAGED host contract, and they answer
 * immediately so a test that just confirms the dialog walks clone → classify →
 * commit without extra plumbing: phase 1 answers the handle of `repository`,
 * phase 2 answers a `plugin` verdict, phase 3 files it. Tests that exercise one
 * phase override that single method.
 */
export function managePageHarness(overrides: Partial<ManagePluginsTabInjected> = {}): {
  /** Props accepted by the component under test (injected face + shell seats). */
  props: ManagePluginsTabProps
  /** The individual spies, for call assertions that do not go through `props`. */
  mocks: ManagePluginsTabInjected
} {
  const mocks = {
    t: makeTranslator('zh'),
    // The settings shell's one owner prop (`settings.section` share).
    close: vi.fn(),
    status: vi.fn(async () => makeStatus(true)),
    list: vi.fn(async () => makeList([])),
    setEnabled: vi.fn(async () => { throw new Error('unused default setEnabled') }),
    setClassification: vi.fn(async () => { throw new Error('unused default setClassification') }),
    requestRemove: vi.fn(async () => { throw new Error('unused default requestRemove') }),
    confirmRemove: vi.fn(async () => { throw new Error('unused default confirmRemove') }),
    search: vi.fn(async () => makeSearchPage([])),
    repositoryDetail: vi.fn(async () => { throw new Error('unused default repositoryDetail') }),
    previewInstall: vi.fn(async (repository: string) => makeInstallReview({ repository })),
    prepareDownload: vi.fn(async (repository: string) => makePreparation({ repository })),
    classifyDownload: vi.fn(async () => makeVerdict({ outcome: 'classified', classification: 'plugin' })),
    commitDownload: vi.fn(async () => makeCommit({ repository: 'acme/helper' })),
    cancelDownload: vi.fn(async () => true),
    // Token tab defaults: an unconfigured but writable deployment, so the tab
    // renders its actionable state and a test that does not care about the
    // credential seam still gets a clean panel.
    tokenStatus: vi.fn(async () => makeTokenStatus()),
    saveToken: vi.fn(async (value: string | null) => makeTokenUpdate({
      configured: true,
      source: 'file',
      ref: 'DSH_GITHUB_TOKEN',
    }, value !== null)),
    clearToken: vi.fn(async () => makeTokenUpdate({ configured: false, ref: 'DSH_GITHUB_TOKEN' })),
  } satisfies ManagePluginsTabInjected & Pick<ManagePluginsTabProps, 't' | 'close'>
  const props: ManagePluginsTabProps = { ...mocks, ...overrides }
  return { props, mocks }
}
