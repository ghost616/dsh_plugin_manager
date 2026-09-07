/**
 * Cross-face shared type home for the plugin market.
 *
 * Compiled under BOTH the Host and the Client leaf so each face's cordis
 * Context declaration merges stay inside its own Program. Cross-boundary
 * consumers must use `import type` only: this module carries zero runtime
 * bytes across the Host/Client edge.
 *
 * The repository/record types below are owned by plugin-market-host. Keep
 * this file free of `node:*` imports so the browser half stays client-safe.
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Runtime brand of a stable plugin-market record key. */
declare const pluginMarketKeyBrand: unique symbol

/**
 * Stable key identifying one third-party plugin managed by the local source
 * repository, e.g. `gh-owner-repo`. Keys never contain the loader-forbidden
 * colon and stay path-safe so they can double as directory names under the
 * repository root. Host code produces branded keys through the validator in
 * `src/host/market/keys.ts`; client faces only receive already-valid keys.
 */
export type PluginMarketKey = string & { readonly [pluginMarketKeyBrand]: 'plugin-market-key' }

/** Trust-gate state of one managed plugin record. */
export type PluginMarketTrustState = 'untrusted' | 'trusted' | 'revoked'

/**
 * Stable failure vocabulary shared by Host errors and future wire codes,
 * shaped `domain/reason`. Host failures throw `MarketError` with one of
 * these codes; never string-match ad hoc.
 */
export type PluginMarketErrorCode =
  | 'config/invalid'
  | 'repository/not-exist'
  | 'repository/not-directory'
  | 'repository/not-writable'
  | 'repository/io'
  | 'record/key-invalid'
  | 'record/exists'
  | 'record/not-found'
  | 'record/corrupt'
  | 'record/io'
  | 'harness/resolve-failed'
  | 'harness/link-conflict'
  | 'harness/io'

/**
 * Supported plugin source kinds, keyed by their `kind` discriminant. The map
 * is merge-extensible: a future source type adds its own key and interface
 * instead of editing existing ones.
 */
export interface PluginMarketSourceMap {
  github: PluginMarketGithubSource
}

/** One plugin source descriptor carried by a plugin record. */
export type PluginMarketSource = PluginMarketSourceMap[keyof PluginMarketSourceMap]

/** A GitHub-hosted plugin source (the V1 install origin). */
export interface PluginMarketGithubSource {
  readonly kind: 'github'
  /** `owner/repo` slug that identifies the repository. */
  readonly repository: string
  /** Tag/version the checkout is pinned to, when known. */
  readonly version: string | null
  /** Commit the local checkout is at, when known. */
  readonly commit: string | null
}

/**
 * One managed plugin record inside the local source repository. `enabled`
 * defaults to false and `trusted` to `'untrusted'` on install: downloading a
 * plugin never activates or trusts it — the user opts in explicitly (the
 * TrustGate flow), and only records listed here are managed by the plugin
 * market.
 */
export interface PluginMarketRecord {
  /** Stable loader-safe key (no colon), e.g. `gh-owner-repo`. */
  readonly key: PluginMarketKey
  readonly source: PluginMarketSource
  /** Directory name of the plugin's source checkout under the repository root. */
  readonly localDirName: string
  /**
   * Cordis plugin entry file of the checkout, relative to `localDirName`
   * (forward-slash segments, no escaping `..`). The loader entry of the
   * plugin is the absolute file URL of `<root>/<localDirName>/<entry>`.
   * Null means the record predates entry metadata; the control service then
   * falls back to the conventional `index.js` entry and surfaces a load
   * failure if the file does not exist.
   */
  readonly entry: string | null
  /** ISO-8601 timestamp of the install. */
  readonly installedAt: string
  /** User opt-in to run the plugin (defaults to false on install). */
  readonly enabled: boolean
  /** Trust-gate state (defaults to 'untrusted' on install). */
  readonly trusted: PluginMarketTrustState
  /** ISO-8601 timestamp of the last trust decision; null before any decision. */
  readonly trustedAt: string | null
}

/** Serialized records file v1: a keyed map under a schema version. */
export interface PluginMarketRecordsFileV1 {
  readonly schemaVersion: 1
  /** Records keyed by their stable key (each map key equals its record `key`). */
  readonly records: Record<string, PluginMarketRecord>
}

/* ------------------------------------------------------------------------ */
/* plugin-control-service cross-face contract (record-driven control)       */
/* ------------------------------------------------------------------------ */

/** Lifecycle state of a managed plugin's live loader entry (server projection). */
export type ManagedPluginPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/**
 * Live loader-side facts of one managed plugin. Read through the loader on
 * every call — the control service keeps no second runtime mirror beyond the
 * transient load-error capture below.
 */
export interface ManagedPluginRuntime {
  /** Exact module specifier of the live loader entry (an absolute file URL). */
  readonly moduleName: string | null
  /** Effective loader enablement (false while the entry is disabled). */
  readonly disabled: boolean
  /** Root-fiber phase of the entry, or null when it has no live fiber. */
  readonly phase: ManagedPluginPhase
  /** Load/update failure captured this session, when the last attempt failed. */
  readonly lastError: string | null
}

/** One managed plugin: its record plus the merged live loader projection. */
export interface ManagedPluginView {
  /** Stable key (equals `record.key` and the loader entry id). */
  readonly key: PluginMarketKey
  readonly record: PluginMarketRecord
  readonly runtime: ManagedPluginRuntime
}

/** Result of the record-driven list. Entries sorted by stable key. */
export interface ManagedPluginList {
  readonly entries: readonly ManagedPluginView[]
}

/** Step-1 answer of the two-step removal protocol (double confirmation). */
export interface RemoveRequest {
  readonly key: PluginMarketKey
  /** Single-use token the confirming call must present. */
  readonly token: string
  /** ISO-8601 expiry of the request; confirmations past it are refused. */
  readonly expiresAt: string
}

/** Outcome of a confirmed removal. */
export interface RemoveOutcome {
  readonly key: PluginMarketKey
  /** Whether a live loader entry was stopped and removed. */
  readonly removedEntry: boolean
  /** Whether the checkout directory inside the repository was deleted. */
  readonly removedDirectory: boolean
  /** Whether the record was cleared. */
  readonly removedRecord: boolean
  /** Checkout directory path that was removed. */
  readonly directory: string
}

/** Structured payload carried by every market wire failure (opt-in fields). */
export interface MarketRemoteErrorDetails {
  readonly key?: string
  readonly path?: string
}

/**
 * Wire failure vocabulary of the market control surface. The Host throws
 * {@link RemoteError} instances with these codes; consumers branch on `code`
 * and never instanceof. Repository/record/harness codes are the existing
 * {@link PluginMarketErrorCode} strings, so the channel never re-copies or
 * re-maps a code that already exists.
 */
export type MarketWireErrorCode =
  | PluginMarketErrorCode
  | 'market/idle'
  | 'market/not-found'
  | 'market/protected'
  | 'market/confirm-required'
  | 'market/confirm-invalid'
  | 'market/confirm-expired'
  | 'market/load-failed'
  | 'market/bad-request'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'config/invalid': MarketRemoteErrorDetails
    'repository/not-exist': MarketRemoteErrorDetails
    'repository/not-directory': MarketRemoteErrorDetails
    'repository/not-writable': MarketRemoteErrorDetails
    'repository/io': MarketRemoteErrorDetails
    'record/key-invalid': MarketRemoteErrorDetails
    'record/exists': MarketRemoteErrorDetails
    'record/not-found': MarketRemoteErrorDetails
    'record/corrupt': MarketRemoteErrorDetails
    'record/io': MarketRemoteErrorDetails
    'harness/resolve-failed': MarketRemoteErrorDetails
    'harness/link-conflict': MarketRemoteErrorDetails
    'harness/io': MarketRemoteErrorDetails
    'market/idle': {}
    'market/not-found': { readonly key: string }
    'market/protected': { readonly key?: string }
    'market/confirm-required': { readonly key: string }
    'market/confirm-invalid': { readonly key: string }
    'market/confirm-expired': { readonly key: string }
    'market/load-failed': { readonly key: string }
    'market/bad-request': {}
  }
}
