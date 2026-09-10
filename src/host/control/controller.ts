/**
 * Record-driven market plugin controller (pure logic).
 *
 * The controller is the single authority over which loader rows exist for the
 * plugins recorded in the local source repository:
 * - `rebuild()` reconciles loader entries against the record file after the
 *   loader tree has settled (startup / restart rebuild, key order);
 * - `setEnabled()` persists the user intent to the record first and then
 *   applies it to the loader entry (disable stops the fiber; enable imports) —
 *   enabling is refused with `market/not-loadable` for a record that has no
 *   runnable entry to load (a `skills`/`other` classification, or a plugin
 *   filed without its entry);
 * - removal is a two-step protocol (`requestRemove` → `confirmRemove`) with a
 *   short-lived single-use token, so one accidental call can never delete.
 *
 * The controller keeps no second mirror of loader runtime state: every read
 * goes through the injected {@link LoaderAdapter} (the same projection the
 * shipped plugin inventory uses). The only transient memory is (a) load/update
 * failures captured this session and (b) pending removal confirmations.
 *
 * All filesystem and loader effects are injected, so unit tests run against
 * fakes; the Cordis/HTTP wiring in `index.ts`/`web-channel.ts` supplies the
 * production implementations.
 */

import { randomBytes } from 'node:crypto'
import type {
  ManagedPluginList,
  ManagedPluginRuntime,
  MarketRemoteErrorDetails,
  MarketWireErrorCode,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
} from '../../types.ts'
import { recordNotLoadableReason } from '../../types.ts'
import type { LoaderAdapter, LoaderEntryMap } from './loader-adapter.ts'
import { indexEntries } from './loader-adapter.ts'
import type { ProtectionPolicy } from './protect.ts'

/** Validity window of one removal confirmation request. */
export const REMOVE_CONFIRM_TTL_MS = 30_000

/**
 * Session error message recorded for a record that is flagged `enabled` in the
 * file but has no runnable entry to load (see `ensureRow`).
 */
const NOT_LOADABLE_ROW_WARNING =
  'This record is marked enabled but cannot be loaded: its checkout has no runnable plugin entry (re-download it to resolve the entry, or leave it disabled).'

/** Typed failure of the control core; the gateway maps it onto the wire. */
export class MarketControlError extends Error {
  readonly code: MarketWireErrorCode
  readonly details: MarketRemoteErrorDetails

  constructor(
    code: MarketWireErrorCode,
    message: string,
    details: MarketRemoteErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'MarketControlError'
    this.code = code
    this.details = details
  }
}

/** Throws the stable not-found failure for a missing record. */
export function recordNotFound(key: PluginMarketKey): never {
  throw new MarketControlError(
    'record/not-found',
    `No plugin record exists for "${key}".`,
    { key },
  )
}

/** Record persistence surface the controller needs. */
export interface RecordsPort {
  list(): Promise<PluginMarketRecord[]>
  get(key: PluginMarketKey): Promise<PluginMarketRecord | null>
  setEnabled(key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord>
  remove(key: PluginMarketKey): Promise<boolean>
}

/** Logger surface (optional; production passes a cordis named logger). */
export interface ControlLogger {
  warn(message: string): void
  error(message: string): void
}

/** Everything the controller needs from its environment. */
export interface MarketControllerDeps {
  /** Canonical absolute root of the local plugin source repository. */
  readonly repositoryRoot: string
  /** Record file access (the repository's records store). */
  readonly records: RecordsPort
  /** Loader row operations (root loader tree). */
  readonly loader: LoaderAdapter
  /** Best-effort removal of a checkout directory. */
  readonly removeDirectory: (directory: string) => Promise<void>
  /** Reserved-key / self-module policy. */
  readonly protection: ProtectionPolicy
  /** Entry-file resolver/cleanup paths (see entry-name.ts helpers). */
  readonly entryModuleOf: (record: PluginMarketRecord) => string
  /** Checkout directory of one record inside the repository. */
  readonly entryDirectoryOf: (record: PluginMarketRecord) => string
  /**
   * Removal confirmation validity window in milliseconds; defaults to
   * {@link REMOVE_CONFIRM_TTL_MS} when omitted.
   */
  readonly confirmTtlMs?: number
  /** Injectable clock for confirmation expiry (defaults to `new Date`). */
  readonly now?: () => Date
  /** Optional structured logger. */
  readonly logger?: ControlLogger
}

/** One pending removal request. */
interface PendingRemoval {
  readonly token: string
  readonly expiresAt: number
}

/**
 * The record-driven controller. Instances are per (repository, loader)
 * activation: construct, call {@link rebuild} once the loader tree is idle,
 * then serve setEnabled / removal / listing until disposed.
 */
export class MarketPluginController {
  /** Loader ids this instance created or adopted (teardown removes them). */
  private readonly owned = new Set<PluginMarketKey>()
  /** Load/update failures captured this session, keyed by record key. */
  private readonly failures = new Map<PluginMarketKey, string>()
  /** Pending removal confirmations, keyed by record key. */
  private readonly pending = new Map<PluginMarketKey, PendingRemoval>()
  private rebuildPromise: Promise<void> | undefined

  constructor(private readonly deps: MarketControllerDeps) {}

  /** True while a record is protected by key or by self-module policy. */
  private assertManageable(key: PluginMarketKey, record: PluginMarketRecord): void {
    if (this.deps.protection.isProtectedKey(key)) {
      throw new MarketControlError(
        'market/protected',
        `"${key}" is a protected plugin-market entry and cannot be managed.`,
        { key },
      )
    }
    if (this.deps.protection.isSelfModule(this.deps.entryModuleOf(record))) {
      throw new MarketControlError(
        'market/protected',
        `"${key}" resolves inside the plugin market's own package and cannot be managed.`,
        { key },
      )
    }
  }

  /**
   * Refuse to enable a record that cannot become a live loader entry: a
   * checkout classified `skills`/`other` (no runnable entry by definition) or
   * a `plugin` record filed without an entry. The refusal is the stable
   * `market/not-loadable` code — the UI disables the enable switch for the
   * same records (see the `loadable` flag of {@link list}). Disabling or
   * removing such a record stays allowed: filing never blocks management.
   */
  private assertLoadable(key: PluginMarketKey, record: PluginMarketRecord): void {
    const reason = recordNotLoadableReason(record)
    if (reason === null) return
    const why = reason === 'classification'
      ? `it is classified "${record.classification ?? 'plugin'}", not a runnable plugin`
      : 'its record carries no plugin entry to load'
    throw new MarketControlError(
      'market/not-loadable',
      `"${key}" cannot be enabled: ${why}. The checkout stays downloaded and manageable; it just has no loader entry.`,
      { key, reason },
    )
  }

  /**
   * Reconcile every loader row against the records, in stable key order, then
   * drop rows whose record vanished. One load failure never aborts the rest:
   * it is captured as this session's `lastError` and surfaced by {@link list}.
   */
  async rebuild(): Promise<void> {
    if (this.rebuildPromise) return this.rebuildPromise
    this.rebuildPromise = this.doRebuild().finally(() => {
      this.rebuildPromise = undefined
    })
    return this.rebuildPromise
  }

  private async doRebuild(): Promise<void> {
    const records = await this.deps.records.list()
    const seen = new Set<string>()
    const live = indexEntries(this.deps.loader.entries())
    for (const record of records) {
      seen.add(record.key)
      await this.ensureRow(record, live)
    }
    for (const key of [...this.owned]) {
      if (seen.has(key)) continue
      await this.removeRow(key)
    }
  }

  /**
   * Persist the intent, then apply it to the loader entry. Enabling is gated:
   * only a `plugin`-classified record with a resolved entry may be loaded
   * (`market/not-loadable` otherwise, before anything is persisted). Disabling
   * always works — it is also how a previously loaded record is stopped.
   */
  async setEnabled(key: PluginMarketKey, enabled: boolean): Promise<PluginMarketRecord> {
    const record = await this.requireRecord(key)
    this.assertManageable(key, record)
    if (enabled) {
      this.assertLoadable(key, record)
      const updated = await this.deps.records.setEnabled(key, true)
      try {
        await this.enableEntry(key, this.deps.entryModuleOf(updated))
      } catch (error) {
        throw this.loadFailure(key, error)
      }
      this.failures.delete(key)
      return (await this.deps.records.get(key)) ?? updated
    }
    try {
      await this.disableEntry(key)
    } catch (error) {
      throw this.loadFailure(key, error)
    }
    this.failures.delete(key)
    return this.deps.records.setEnabled(key, false)
  }

  /** Live view: records merged with the loader projection (no second cache). */
  async list(): Promise<ManagedPluginList> {
    const records = await this.deps.records.list()
    const live = indexEntries(this.deps.loader.entries())
    return {
      entries: records.map((record) => {
        const entry = live.get(record.key)
        return {
          key: record.key,
          record,
          runtime: this.runtimeView(record, entry),
          // Derived from the record alone (never from the live row), so the
          // flag agrees with the setEnabled gate of the host layer.
          loadable: recordNotLoadableReason(record) === null,
        }
      }),
    }
  }

  /** Step 1 of removal: mint a short-lived single-use confirmation token. */
  async requestRemove(key: PluginMarketKey): Promise<RemoveRequest> {
    const record = await this.requireRecord(key)
    this.assertManageable(key, record)
    const token = randomBytes(16).toString('hex')
    const now = (this.deps.now ?? (() => new Date()))()
    const ttl = this.deps.confirmTtlMs ?? REMOVE_CONFIRM_TTL_MS
    const expiresAt = new Date(now.getTime() + ttl)
    this.pending.set(key, { token, expiresAt: expiresAt.getTime() })
    return { key, token, expiresAt: expiresAt.toISOString() }
  }

  /** Step 2 of removal: stop, delete the checkout, clear the record. */
  async confirmRemove(key: PluginMarketKey, token: string): Promise<RemoveOutcome> {
    const record = await this.requireRecord(key)
    this.assertManageable(key, record)
    const pending = this.pending.get(key)
    if (pending === undefined) {
      throw new MarketControlError(
        'market/confirm-required',
        `Removal of "${key}" needs a requestRemove() confirmation first.`,
        { key },
      )
    }
    const now = (this.deps.now ?? (() => new Date()))()
    if (now.getTime() >= pending.expiresAt) {
      this.pending.delete(key)
      throw new MarketControlError(
        'market/confirm-expired',
        `The removal confirmation for "${key}" expired; request a new one.`,
        { key },
      )
    }
    if (pending.token !== token) {
      throw new MarketControlError(
        'market/confirm-invalid',
        `The removal confirmation token for "${key}" does not match.`,
        { key },
      )
    }
    this.pending.delete(key)

    const directory = this.deps.entryDirectoryOf(record)
    let removedEntry = false
    let removedDirectory = false
    // 1. Stop and remove the live loader entry first.
    const entry = indexEntries(this.deps.loader.entries()).get(key)
    if (entry !== undefined) {
      await this.removeRow(key)
      removedEntry = true
    }
    // 2. Delete the checkout directory (record stays until it succeeds, so a
    //    partial failure keeps the record for a retried confirmation).
    try {
      await this.deps.removeDirectory(directory)
      removedDirectory = true
    } catch (error) {
      throw new MarketControlError(
        'repository/io',
        `Failed to remove the checkout directory of "${key}".`,
        { key, path: directory },
        { cause: error },
      )
    }
    // 3. Clear the record.
    const removedRecord = await this.deps.records.remove(key)
    this.failures.delete(key)
    return { key, removedEntry, removedDirectory, removedRecord, directory }
  }

  /** Remove every loader row this instance owns (control teardown). */
  async dispose(): Promise<void> {
    for (const key of [...this.owned]) {
      try {
        await this.deps.loader.remove(key)
      } catch (error) {
        this.deps.logger?.error(`market control dispose: ${describeError(error)}`)
      }
    }
    this.owned.clear()
    this.failures.clear()
    this.pending.clear()
  }

  private async requireRecord(key: PluginMarketKey): Promise<PluginMarketRecord> {
    const record = await this.deps.records.get(key)
    if (record === null) recordNotFound(key)
    return record
  }

  /**
   * Align one record's loader row right away (used after an install/overwrite
   * registers a record outside a full rebuild). A newly installed record is
   * `enabled: false`, so its row is created disabled and any previously active
   * row of an overwritten record is stopped.
   */
  async syncRecordRow(record: PluginMarketRecord): Promise<void> {
    await this.ensureRow(record, indexEntries(this.deps.loader.entries()))
  }

  /**
   * Create or align one loader row with the record's desired state.
   *
   * Every recorded plugin gets a row — including a non-loadable (`skills`/
   * `other`, entry-less) record, whose row is FORCED disabled: the row is what
   * the managed view projects, and a disabled entry never imports anything.
   * The gate lives in {@link setEnabled} (`market/not-loadable`), and this row
   * builder enforces the same rule for the states the user cannot reach through
   * the service: a record whose `enabled` flag was flipped behind the
   * controller's back (a hand-edited records file) is never given an enabled
   * row; the flag is written back to `false` and the reason is recorded as this
   * session's row warning, so the managed view cannot claim a plugin is on when
   * nothing can be imported.
   */
  private async ensureRow(
    record: PluginMarketRecord,
    live: LoaderEntryMap,
  ): Promise<void> {
    const key = record.key
    const notLoadable = recordNotLoadableReason(record)
    const forcedDisabled = notLoadable !== null && record.enabled
    if (forcedDisabled) {
      this.failures.set(key, NOT_LOADABLE_ROW_WARNING)
      this.deps.logger?.warn(
        `market rebuild: "${key}" is recorded enabled but is not loadable (${notLoadable}); its loader row stays disabled.`,
      )
    }
    const expected = this.deps.entryModuleOf(record)
    let entry = live.get(key)
    if (entry !== undefined && entry.moduleName !== expected) {
      // A row wearing our id for a different module is stale; replace it.
      await this.removeRow(key)
      entry = undefined
    }
    const wantDisabled = forcedDisabled || !record.enabled
    try {
      if (entry === undefined) {
        await this.deps.loader.create({
          id: key,
          moduleName: expected,
          disabled: wantDisabled,
        })
      } else if (entry.disabled !== wantDisabled) {
        await this.deps.loader.update(key, { disabled: wantDisabled })
      }
      this.owned.add(key)
      if (!forcedDisabled) this.failures.delete(key)
      if (forcedDisabled) await this.clearEnabledFlag(key)
    } catch (error) {
      this.failures.set(key, describeError(error))
      this.deps.logger?.warn(
        `market rebuild: "${key}" could not be ${wantDisabled ? 'disabled' : 'started'}: ${describeError(error)}`,
      )
    }
  }

  /**
   * Write an unreachable `enabled: true` of a non-loadable record back to
   * `false`, so the record agrees with the row the loader actually holds. A
   * failure here is logged only: the row is already disabled, and the next
   * rebuild retries the write-back.
   */
  private async clearEnabledFlag(key: PluginMarketKey): Promise<void> {
    try {
      await this.deps.records.setEnabled(key, false)
    } catch (error) {
      this.deps.logger?.warn(
        `market rebuild: could not clear the enabled flag of the non-loadable "${key}": ${describeError(error)}`,
      )
    }
  }

  private async enableEntry(key: PluginMarketKey, expected: string): Promise<void> {
    const entry = indexEntries(this.deps.loader.entries()).get(key)
    if (entry === undefined) {
      await this.deps.loader.create({ id: key, moduleName: expected, disabled: false })
      this.owned.add(key)
      return
    }
    if (entry.disabled) {
      await this.deps.loader.update(key, { disabled: false })
      this.owned.add(key)
      return
    }
    if (entry.phase === 'failed') {
      // Restart a failed fiber: dispose, then load again.
      await this.deps.loader.update(key, { disabled: true })
      await this.deps.loader.update(key, { disabled: false })
      this.owned.add(key)
    }
  }

  private async disableEntry(key: PluginMarketKey): Promise<void> {
    const entry = indexEntries(this.deps.loader.entries()).get(key)
    if (entry !== undefined && !entry.disabled) {
      await this.deps.loader.update(key, { disabled: true })
    }
    this.failures.delete(key)
  }

  private async removeRow(key: PluginMarketKey): Promise<void> {
    try {
      await this.deps.loader.remove(key)
    } finally {
      this.owned.delete(key)
      this.failures.delete(key)
    }
  }

  private loadFailure(key: PluginMarketKey, error: unknown): MarketControlError {
    const message = describeError(error)
    this.failures.set(key, message)
    return new MarketControlError(
      'market/load-failed',
      `"${key}" failed to ${message}`,
      { key },
      { cause: error },
    )
  }

  private runtimeView(
    record: PluginMarketRecord,
    entry: ReturnType<LoaderEntryMap['get']>,
  ): ManagedPluginRuntime {
    const failed = this.failures.get(record.key)
    return {
      moduleName: entry?.moduleName ?? null,
      disabled: entry === undefined ? true : entry.disabled,
      phase: entry?.phase ?? null,
      lastError: failed ?? null,
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}