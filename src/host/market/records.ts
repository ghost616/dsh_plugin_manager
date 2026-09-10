import {
  DEFAULT_PLUGIN_MARKET_CLASSIFICATION,
  isPluginMarketClassification,
  type PluginMarketClassification,
  type PluginMarketKey,
  type PluginMarketRecord,
  type PluginMarketRecordsFileV1,
  type PluginMarketSource,
  type PluginMarketTrustState,
} from '../../types.ts'
import { MarketError } from './errors.ts'
import { errorCode, NodeFs, type FsLike } from './fs.ts'
import { isValidPluginKey } from './keys.ts'
import {
  isCheckoutEntryPath,
  isManagedLocalDirName,
  parseRefSeg,
  splitManagedLocalDir,
} from './paths.ts'

/** Schema version written by this store (`plugins.json` records file v1). */
export const RECORDS_SCHEMA_VERSION = 1 as const

/** Input for {@link PluginRecordStore.add}; activation defaults are applied by the store. */
export interface NewPluginRecord {
  /** Stable loader-safe key (no colon), e.g. `gh-owner-repo`. */
  readonly key: PluginMarketKey
  readonly source: PluginMarketSource
  /**
   * Checkout location of the plugin relative to the repository root: the
   * legacy single directory name (e.g. `gh-owner-repo`) or the v2 multi-level
   * ref path `<owner>/<repo>/<branch|tag>/<refSeg>` (see paths.ts).
   */
  readonly localDirName: string
  /**
   * Plugin entry file relative to `localDirName` (optional). Records created
   * without it default to null: either the control service falls back to the
   * conventional `index.js` entry (classification `plugin`) or the checkout is
   * deliberately filed without a runnable entry (classification `skills`/
   * `other`).
   */
  readonly entry?: string
  /**
   * Classification tag of the checkout. Omitting it applies a cross-consistent
   * default: `'plugin'` when an `entry` is supplied (the historical meaning of
   * "a record we installed for its entry"), otherwise `'other'` — an entry-less
   * record is never written as `plugin`. Passing `'plugin'` together with no
   * entry is rejected (`record/invalid`).
   */
  readonly classification?: PluginMarketClassification
}

/** Options for {@link PluginRecordStore}. */
export interface PluginRecordStoreOptions {
  /** Injectable file-system adapter (defaults to {@link NodeFs}). */
  fs?: FsLike
}

/**
 * Read/write facade over the repository records file v1 (`plugins.json`).
 *
 * The store is intentionally stateless between calls: every operation loads
 * and validates the current file, applies one change and persists through an
 * atomic temp-file + rename write (same directory ⇒ same volume). A corrupted
 * file is reported with a stable `record/corrupt` code and never silently
 * overwritten. Mutations through one instance are serialized internally;
 * callers mutating through several instances must serialize their operations.
 */
export class PluginRecordStore {
  private readonly fs: FsLike
  private task: Promise<unknown> = Promise.resolve()

  constructor(
    readonly filePath: string,
    options: PluginRecordStoreOptions = {},
  ) {
    this.fs = options.fs ?? NodeFs
  }

  /** Load and validate the current document; create the default empty file on first use. */
  async load(): Promise<PluginMarketRecord[]> {
    const document = await this.readDocument()
    return Object.values(document.records)
  }

  /** All records sorted by stable key (stable display order). */
  async list(): Promise<PluginMarketRecord[]> {
    const records = await this.load()
    return records.sort((a, b) => compareKey(a.key, b.key))
  }

  /** One record by key, or null when it is not recorded. */
  async get(key: PluginMarketKey): Promise<PluginMarketRecord | null> {
    const records = await this.load()
    return records.find((record) => record.key === key) ?? null
  }

  /**
   * Add a plugin record. Activation defaults are enforced here: `enabled` is
   * always false and `trusted` always `'untrusted'` — downloading never
   * activates or trusts a plugin. The classification tag is always written
   * (defaulting to `'plugin'` with an entry, `'other'` without one, see
   * {@link NewPluginRecord.classification}). Input fields are validated
   * synchronously before anything touches the file (`record/key-invalid` for
   * the key, `record/invalid` for `localDirName`/`entry`/`classification` and
   * for an entry-less `plugin`), so a bad value can never be persisted and
   * later misreport the whole file as `record/corrupt`.
   */
  async add(input: NewPluginRecord): Promise<PluginMarketRecord> {
    return this.exclusive(async () => {
      assertValidInput(input, this.filePath)
      const document = await this.readDocument()
      if (document.records[input.key] !== undefined) {
        throw new MarketError('record/exists', `A plugin record for "${input.key}" already exists.`, { path: this.filePath })
      }
      const record = buildRecord(input)
      await this.persist(this.withRecord(document, record))
      return record
    })
  }

  /**
   * Add-or-replace one plugin record (used by the install pipeline for
   * same-key overwrite updates). Like {@link PluginRecordStore.add} the record
   * is created with `enabled: false` and an explicit classification tag;
   * `trusted` stays `'untrusted'` unless a TrustGate-confirmed install passes
   * `{ trusted: true }`, which stamps `trusted` and `trustedAt` in the same
   * atomic write. The whole record is replaced, so the classification of the
   * new checkout wins over the superseded one.
   */
  async register(input: NewPluginRecord, trust?: { readonly trusted: true }): Promise<PluginMarketRecord> {
    return this.exclusive(async () => {
      assertValidInput(input, this.filePath)
      const document = await this.readDocument()
      const record = buildRecord(input, trust)
      await this.persist(this.withRecord(document, record))
      return record
    })
  }

  /** Flip the enabled flag of one record. */
  async setEnabled(key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord> {
    return this.update(key, (record) => {
      if (record.enabled === enabled) return record
      return { ...record, enabled }
    })
  }

  /** Record a trust decision (stamping `trustedAt`) for one record. */
  async setTrusted(key: PluginMarketKey, trusted: PluginMarketTrustState): Promise<PluginMarketRecord> {
    return this.update(key, (record) => {
      if (record.trusted === trusted) return record
      return { ...record, trusted, trustedAt: new Date().toISOString() }
    })
  }

  /** Remove one record; returns false when no record existed for the key. */
  async remove(key: PluginMarketKey): Promise<boolean> {
    return this.exclusive(async () => {
      const document = await this.readDocument()
      const record = document.records[key]
      if (record === undefined) return false
      const next: PluginMarketRecordsFileV1 = {
        schemaVersion: RECORDS_SCHEMA_VERSION,
        records: { ...document.records },
      }
      delete next.records[key]
      await this.persist(next)
      return true
    })
  }

  /** Serialize one read-modify-write so concurrent calls never lose an update. */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.task.then(operation, operation)
    this.task = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async update(
    key: PluginMarketKey,
    change: (record: PluginMarketRecord) => PluginMarketRecord,
  ): Promise<PluginMarketRecord> {
    return this.exclusive(async () => {
      const document = await this.readDocument()
      const record = document.records[key]
      if (record === undefined) {
        throw new MarketError('record/not-found', `No plugin record exists for "${key}".`, { path: this.filePath })
      }
      const nextRecord = change(record)
      await this.persist(this.withRecord(document, nextRecord))
      return nextRecord
    })
  }

  private withRecord(
    document: PluginMarketRecordsFileV1,
    record: PluginMarketRecord,
  ): PluginMarketRecordsFileV1 {
    return {
      schemaVersion: RECORDS_SCHEMA_VERSION,
      records: { ...document.records, [record.key]: record },
    }
  }

  /** Read + validate the current document; create the default file when missing. */
  private async readDocument(): Promise<PluginMarketRecordsFileV1> {
    let text: string
    try {
      text = await this.fs.readFile(this.filePath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        const fresh: PluginMarketRecordsFileV1 = { schemaVersion: RECORDS_SCHEMA_VERSION, records: {} }
        await this.persist(fresh)
        return fresh
      }
      throw new MarketError('record/io', 'Failed to read the plugin records file.', { path: this.filePath, cause: error })
    }
    return parseDocument(text, this.filePath)
  }

  /** Atomic persist: write a temp sibling then rename over the records file. */
  private async persist(document: PluginMarketRecordsFileV1): Promise<void> {
    const text = `${JSON.stringify(document, null, 2)}\n`
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${(nextTmpCounter++).toString(36)}`
    try {
      await this.fs.writeFile(tmpPath, text)
      await this.fs.rename(tmpPath, this.filePath)
    } catch (error) {
      try {
        await this.fs.unlink(tmpPath)
      } catch {
        // Best-effort cleanup; the persist error below is what matters.
      }
      throw new MarketError('record/io', 'Failed to persist the plugin records file.', { path: this.filePath, cause: error })
    }
  }
}

let nextTmpCounter = 0

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Strict parse: any structural problem is `record/corrupt`, never a silent overwrite. */
function parseDocument(text: string, filePath: string): PluginMarketRecordsFileV1 {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    corrupt(filePath, 'the file is not valid JSON')
  }
  if (!isObject(value)) corrupt(filePath, 'the document is not an object')
  if (value.schemaVersion !== RECORDS_SCHEMA_VERSION) {
    corrupt(filePath, `unsupported schema version ${JSON.stringify(value.schemaVersion)} (expected ${RECORDS_SCHEMA_VERSION})`)
  }
  const body = value.records
  if (!isObject(body)) corrupt(filePath, 'the document lacks a "records" object')
  const records: Record<string, PluginMarketRecord> = {}
  for (const [rawKey, rawRecord] of Object.entries(body)) {
    if (!isValidPluginKey(rawKey)) {
      corrupt(filePath, `a record map key "${rawKey}" is not a valid stable plugin-market key`)
    }
    const record = validateRecord(rawRecord, filePath)
    if (record.key !== rawKey) {
      corrupt(filePath, `the record under "${rawKey}" declares a different key "${record.key}"`)
    }
    records[rawKey] = record
  }
  return { schemaVersion: RECORDS_SCHEMA_VERSION, records }
}

/** Field-wise strict validation returning fully typed values (throws on any problem). */
function validateRecord(value: unknown, filePath: string): PluginMarketRecord {
  if (!isObject(value)) corrupt(filePath, 'a record entry is not an object')
  const key = expectValidKey(value.key, filePath, 'record key')
  const source = expectSource(value.source, filePath, key)
  const localDirName = expectLocalDirName(value.localDirName, filePath, key)
  const problem = refDirConsistencyProblem(localDirName, source)
  if (problem !== null) corrupt(filePath, `record "${key}" ${problem}`)
  const entry = value.entry === undefined || value.entry === null
    ? null
    : expectEntry(value.entry, filePath, key)
  const classification = expectClassification(value.classification, filePath, key)
  const installedAt = expectIsoDate(value.installedAt, filePath, `record "${key}" "installedAt"`)
  const enabled = expectBoolean(value.enabled, filePath, `record "${key}" "enabled"`)
  const trusted = expectTrustState(value.trusted, filePath, key)
  const trustedAt = value.trustedAt === null
    ? null
    : expectIsoDate(value.trustedAt, filePath, `record "${key}" "trustedAt"`)
  return { key, source, localDirName, entry, classification, installedAt, enabled, trusted, trustedAt }
}

function expectValidKey(value: unknown, filePath: string, what: string): PluginMarketKey {
  if (typeof value !== 'string' || !isValidPluginKey(value)) {
    corrupt(filePath, `a ${what} is not a valid stable plugin-market key`)
  }
  return value
}

function expectSource(value: unknown, filePath: string, key: PluginMarketKey): PluginMarketSource {
  if (!isObject(value)) corrupt(filePath, `record "${key}" has no "source" object`)
  if (value.kind !== 'github') {
    corrupt(filePath, `record "${key}" uses an unsupported source kind ${JSON.stringify(value.kind)}`)
  }
  const repository = typeof value.repository === 'string' && value.repository.length > 0
    ? value.repository
    : corrupt(filePath, `record "${key}" has an invalid github source "repository"`)
  // refKind is optional (legacy v1 records predate it); when present it must
  // be exactly branch/tag.
  const refKind = value.refKind === undefined || value.refKind === null
    ? undefined
    : value.refKind === 'branch' || value.refKind === 'tag'
      ? value.refKind
      : corrupt(filePath, `record "${key}" has an invalid github source "refKind"`)
  const version = value.version === null || typeof value.version === 'string'
    ? (value.version ?? null)
    : corrupt(filePath, `record "${key}" has an invalid github source "version"`)
  const commit = value.commit === null || typeof value.commit === 'string'
    ? (value.commit ?? null)
    : corrupt(filePath, `record "${key}" has an invalid github source "commit"`)
  // exactOptionalPropertyTypes: only attach refKind when the record carries it.
  return refKind === undefined
    ? { kind: 'github', repository, version, commit }
    : { kind: 'github', refKind, repository, version, commit }
}

function expectLocalDirName(value: unknown, filePath: string, key: PluginMarketKey): string {
  if (typeof value !== 'string' || !isManagedLocalDirName(value)) {
    corrupt(filePath, `record "${key}" has an invalid "localDirName": either a single legacy checkout segment or the v2 path <owner>/<repo>/<branch|tag>/<refSeg>`)
  }
  return value
}

/**
 * A relative plugin-entry path inside a checkout: forward-slash segments, no
 * drive/absolute prefix, no empty or escaping (`..`) segment, no backslash.
 */
function expectEntry(value: unknown, filePath: string, key: PluginMarketKey): string {
  if (typeof value !== 'string' || !isCheckoutEntryPath(value)) {
    corrupt(filePath, `record "${key}" has an invalid "entry": a relative forward-slash path inside the checkout, without escaping ".." or a backslash`)
  }
  return value
}

/**
 * Classification tag of one persisted record. A missing tag (legacy pre-tag
 * files, and the null JSON representation of an absent field) reads as the
 * backward-compatible default `'plugin'`; anything present must be exactly one
 * of the three persisted labels — an unknown value is corruption, never a
 * silent fallback (the tag decides whether the checkout is loader-registrable).
 *
 * Cross-consistency with `entry` is intentionally NOT enforced here: records
 * written before the tag existed carry `classification` absent/`plugin` even
 * with a null entry (the store only started resolving entries with the tag),
 * so enforcing it would report healthy historical files as corrupt. The
 * contradiction is rejected at the write boundary instead (assertValidInput).
 */
function expectClassification(
  value: unknown,
  filePath: string,
  key: PluginMarketKey,
): PluginMarketClassification {
  if (value === undefined || value === null) return DEFAULT_PLUGIN_MARKET_CLASSIFICATION
  if (isPluginMarketClassification(value)) return value
  corrupt(filePath, `record "${key}" has an invalid "classification" ${JSON.stringify(value)} (expected "plugin", "skills" or "other")`)
}

function expectIsoDate(value: unknown, filePath: string, what: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    corrupt(filePath, `${what} is not an ISO date string`)
  }
  return value
}

function expectBoolean(value: unknown, filePath: string, what: string): boolean {
  return typeof value === 'boolean' ? value : corrupt(filePath, `${what} is not a boolean`)
}

function expectTrustState(value: unknown, filePath: string, key: PluginMarketKey): PluginMarketTrustState {
  if (value === 'untrusted' || value === 'trusted' || value === 'revoked') return value
  corrupt(filePath, `record "${key}" has an invalid "trusted" state`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Fail-fast input guard shared by {@link PluginRecordStore.add} and `.register`. */
function assertValidInput(input: NewPluginRecord, filePath: string): void {
  if (!isValidPluginKey(input.key)) {
    throw new MarketError('record/key-invalid', `"${input.key}" is not a valid stable plugin-market key.`, { path: filePath })
  }
  if (!isManagedLocalDirName(input.localDirName)) {
    throw new MarketError(
      'record/invalid',
      `localDirName "${input.localDirName}" is not a valid checkout location: either a single legacy checkout segment or the v2 path <owner>/<repo>/<branch|tag>/<refSeg>.`,
      { path: filePath },
    )
  }
  const problem = refDirConsistencyProblem(input.localDirName, input.source)
  if (problem !== null) {
    throw new MarketError('record/invalid', problem, { path: filePath })
  }
  if (input.entry !== undefined && !isCheckoutEntryPath(input.entry)) {
    throw new MarketError(
      'record/invalid',
      `entry "${input.entry}" is not a valid checkout-relative entry path (forward-slash segments, no escaping ".." or backslash).`,
      { path: filePath },
    )
  }
  if (input.classification !== undefined && !isPluginMarketClassification(input.classification)) {
    throw new MarketError(
      'record/invalid',
      `classification ${JSON.stringify(input.classification)} is not a valid classification tag ("plugin", "skills" or "other").`,
      { path: filePath },
    )
  }
  // Write-boundary cross-consistency: a checkout classified `plugin` is by
  // definition one whose runnable entry was resolved, so an entry-less
  // `plugin` record is a contradiction. Loading deliberately does NOT enforce
  // this (see expectClassification): checkouts installed before the tag
  // existed were always written as `plugin`, entry or not, and those records
  // must keep loading. New contradictions are rejected before anything is
  // written.
  if (input.classification === 'plugin' && input.entry === undefined) {
    throw new MarketError(
      'record/invalid',
      'a record classified "plugin" must carry its runnable "entry" — register an entry-less checkout as "skills" or "other".',
      { path: filePath },
    )
  }
}

/**
 * A v2 multi-level localDirName must agree with the record's github source:
 * the owner/repo/kind segments identify the same repository + ref kind as the
 * source, and the trailing refSeg must decode to the source `version` (the
 * pinned branch/tag name). Legacy single-segment dirs carry no such coupling
 * and are left as-is. Returns a human description of the mismatch, or null
 * when the pair is consistent.
 */
function refDirConsistencyProblem(localDirName: string, source: PluginMarketSource): string | null {
  const parts = splitManagedLocalDir(localDirName)
  if (parts === null) return null
  if (source.kind !== 'github') {
    return `uses a v2 ref directory "${localDirName}" with a non-github source`
  }
  const { owner, repo, kind, refSeg } = parts
  if (source.repository !== `${owner}/${repo}`) {
    return `has a v2 directory "${localDirName}" whose owner/repo do not match its github source "${source.repository}"`
  }
  if (source.refKind !== kind) {
    return `has a v2 directory kind "${kind}" that disagrees with its source refKind ${JSON.stringify(source.refKind)}`
  }
  const refName = parseRefSeg(refSeg)
  if (source.version === null || refName === null || source.version !== refName) {
    return `has a v2 refSeg "${refSeg}" that does not decode to its source version`
  }
  return null
}

/** One persisted record with the enforced activation/trust defaults. */
function buildRecord(input: NewPluginRecord, trust?: { readonly trusted: true }): PluginMarketRecord {
  const now = new Date().toISOString()
  const confirmed = trust !== undefined
  return {
    key: input.key,
    source: input.source,
    localDirName: input.localDirName,
    entry: input.entry === undefined ? null : input.entry,
    // Always written: a record without a tag would be ambiguous for consumers.
    // The default keeps the historical meaning ("a record we installed for its
    // entry") and stays cross-consistent with the entry: an entry-less record
    // cannot be `plugin`. Explicit tags are already validated by
    // assertValidInput, so `input.classification` here is consistent by then.
    classification: input.classification
      ?? (input.entry === undefined ? 'other' : DEFAULT_PLUGIN_MARKET_CLASSIFICATION),
    installedAt: now,
    enabled: false,
    trusted: confirmed ? 'trusted' : 'untrusted',
    trustedAt: confirmed ? now : null,
  }
}

/** Throw the stable corruption error; the file itself is never modified here. */
function corrupt(filePath: string, detail: string): never {
  throw new MarketError(
    'record/corrupt',
    `The plugin records file is corrupted: ${detail}. The file was left untouched — fix or remove it manually so it can be re-initialized.`,
    { path: filePath },
  )
}
