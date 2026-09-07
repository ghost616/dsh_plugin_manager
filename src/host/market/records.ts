import type {
  PluginMarketKey,
  PluginMarketRecord,
  PluginMarketRecordsFileV1,
  PluginMarketSource,
  PluginMarketTrustState,
} from '../../types.ts'
import { MarketError } from './errors.ts'
import { errorCode, NodeFs, type FsLike } from './fs.ts'
import { isValidPluginKey } from './keys.ts'

/** Schema version written by this store (`plugins.json` records file v1). */
export const RECORDS_SCHEMA_VERSION = 1 as const

/** Input for {@link PluginRecordStore.add}; activation defaults are applied by the store. */
export interface NewPluginRecord {
  /** Stable loader-safe key (no colon), e.g. `gh-owner-repo`. */
  readonly key: PluginMarketKey
  readonly source: PluginMarketSource
  /** Directory name of the plugin's source checkout under the repository root. */
  readonly localDirName: string
  /**
   * Plugin entry file relative to `localDirName` (optional). Records created
   * without it default to null: the control service then falls back to the
   * conventional `index.js` entry.
   */
  readonly entry?: string
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
   * activates or trusts a plugin.
   */
  async add(input: NewPluginRecord): Promise<PluginMarketRecord> {
    return this.exclusive(async () => {
      const document = await this.readDocument()
      if (document.records[input.key] !== undefined) {
        throw new MarketError('record/exists', `A plugin record for "${input.key}" already exists.`, { path: this.filePath })
      }
      const record: PluginMarketRecord = {
        key: input.key,
        source: input.source,
        localDirName: input.localDirName,
        entry: input.entry === undefined ? null : input.entry,
        installedAt: new Date().toISOString(),
        enabled: false,
        trusted: 'untrusted',
        trustedAt: null,
      }
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
  const entry = value.entry === undefined || value.entry === null
    ? null
    : expectEntry(value.entry, filePath, key)
  const installedAt = expectIsoDate(value.installedAt, filePath, `record "${key}" "installedAt"`)
  const enabled = expectBoolean(value.enabled, filePath, `record "${key}" "enabled"`)
  const trusted = expectTrustState(value.trusted, filePath, key)
  const trustedAt = value.trustedAt === null
    ? null
    : expectIsoDate(value.trustedAt, filePath, `record "${key}" "trustedAt"`)
  return { key, source, localDirName, entry, installedAt, enabled, trusted, trustedAt }
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
  const version = value.version === null || typeof value.version === 'string'
    ? (value.version ?? null)
    : corrupt(filePath, `record "${key}" has an invalid github source "version"`)
  const commit = value.commit === null || typeof value.commit === 'string'
    ? (value.commit ?? null)
    : corrupt(filePath, `record "${key}" has an invalid github source "commit"`)
  return { kind: 'github', repository, version, commit }
}

function expectLocalDirName(value: unknown, filePath: string, key: PluginMarketKey): string {
  if (typeof value !== 'string' || !isLocalDirSegment(value)) {
    corrupt(filePath, `record "${key}" has an invalid "localDirName"`)
  }
  return value
}

function isLocalDirSegment(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false
  if (value === '.' || value === '..') return false
  return !/[\\/\u0000]/.test(value)
}

/**
 * A relative plugin-entry path inside a checkout: forward-slash segments, no
 * drive/absolute prefix, no empty or escaping (`..`) segment, no backslash.
 */
function isEntryPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false
  if (/^[/\\]/.test(value) || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !/[\\\u0000]/.test(segment))
}

function expectEntry(value: unknown, filePath: string, key: PluginMarketKey): string {
  if (typeof value !== 'string' || !isEntryPath(value)) {
    corrupt(filePath, `record "${key}" has an invalid "entry": a relative forward-slash path inside the checkout, without escaping ".." or a backslash`)
  }
  return value
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

/** Throw the stable corruption error; the file itself is never modified here. */
function corrupt(filePath: string, detail: string): never {
  throw new MarketError(
    'record/corrupt',
    `The plugin records file is corrupted: ${detail}. The file was left untouched — fix or remove it manually so it can be re-initialized.`,
    { path: filePath },
  )
}
