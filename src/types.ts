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
 * Kind of one GitHub ref a v2 record/review pins to. Branch and tag refs share
 * one name namespace on the remote, so installs and installed markers pair the
 * ref name with this kind to tell same-name branches and tags apart.
 */
export type GithubRefKind = 'branch' | 'tag'

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
  | 'record/invalid'
  | 'harness/resolve-failed'
  | 'harness/link-conflict'
  | 'harness/io'
  | 'github/auth'
  | 'github/rate-limit'
  | 'github/network'
  | 'github/not-found'
  | 'github/bad-response'
  | 'github/bad-request'
  | 'install/dir-exists'
  | 'install/dir-in-use'
  | 'install/entry-missing'
  | 'install/package-invalid'
  | 'install/git-failed'
  | 'install/deps-failed'
  | 'install/io'
  | 'gate/consent-required'
  /**
   * The smart-install analyzer was invoked without a usable LLM endpoint
   * (`Config.llm.provider`/`Config.llm.model` missing); the assembly layer
   * checks this before any analysis call.
   */
  | 'market/llm-unconfigured'
  /** The analyzer's LLM completion call failed (transport/finish error). */
  | 'market/llm-failed'
  /** The analyzer's LLM output could not be parsed or failed field validation. */
  | 'market/llm-bad-output'
  /**
   * An I/O failure occurred while reading the analyzed checkout or probing its
   * entry through the filesystem adapter (native errors never cross the wire).
   */
  | 'market/io'
  /** The analyzed checkout is a skills pack, not an installable dsh plugin. */
  | 'market/unsupported-skills'
  /** The analyzed checkout is a configuration preset, not an installable dsh plugin. */
  | 'market/unsupported-preset'
  /**
   * The analyzed checkout looks like a dsh plugin but has no ready-to-load
   * entry (it needs a build step first); the reason explains how to build it.
   */
  | 'market/unsupported-build'
  /** The analyzed checkout is tooling/other, not an installable dsh plugin. */
  | 'market/unsupported-other'

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
  /**
   * Whether the installed checkout was pinned to a branch or a tag. Absent on
   * legacy pre-v2 records that predate the ref-kind metadata (they installed
   * whatever the default branch was at the time); v2 installs always carry it.
   */
  readonly refKind?: GithubRefKind
  /** Branch/tag name the checkout is pinned to, when known. */
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
  /**
   * Stable loader-safe key (no colon), e.g. `gh-owner-repo`. V2 installs are
   * keyed uniquely per `(owner, repo, ref-kind, ref)` tuple
   * (see `pluginKeyForGithubRef`); legacy single-ref records keep their
   * pre-v2 slug-derived keys.
   */
  readonly key: PluginMarketKey
  readonly source: PluginMarketSource
  /**
   * Checkout location of the plugin relative to the repository root,
   * forward-slash separated. V2 ref installs store the multi-level ref path
   * `<owner>/<repo>/<branch|tag>/<refSeg>`; legacy records carry the former
   * single-segment checkout directory name and keep loading/working as-is.
   */
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
/* plugin-market-host source contract (search / preview / trust preview)    */
/* ------------------------------------------------------------------------ */

/** One GitHub repository search hit (repo metadata only, no secrets). */
export interface GitHubRepoSummary {
  /** `owner/repo` slug that identifies the repository. */
  readonly repository: string
  readonly name: string
  readonly description: string | null
  /** Stargazer count. */
  readonly stars: number
  /** ISO-8601 last-push/update timestamp, when the API reported one. */
  readonly updatedAt: string | null
  /** Browser URL of the repository. */
  readonly url: string
  /** Clone URL used by the install pipeline. */
  readonly cloneUrl: string
}

/** One search response page (never caches any credential). */
export interface GitHubSearchPage {
  readonly totalCount: number
  readonly items: readonly GitHubRepoSummary[]
}

/** Dependency snapshot of one plugin manifest, shown by the TrustGate preview. */
export interface PluginDependencyPreview {
  readonly dependencies: readonly string[]
  readonly peerDependencies: readonly string[]
}

/** Manifest summary of one plugin checkout, read before installation. */
export interface PluginManifestPreview {
  /** `name` from package.json when readable. */
  readonly name: string | null
  /** `version` from package.json when readable. */
  readonly version: string | null
  readonly dependencies: PluginDependencyPreview
}

/**
 * Outcome of the pre-download preview. `ready` means the remote manifest was
 * read and summarized; `degraded` means only repository metadata is available
 * (raw manifest unreadable/unparsable) — confirmation stays possible, and the
 * UI labels the reason ("依赖不可读"), carrying the underlying host code.
 */
export type PluginPreviewOutcome =
  | { readonly status: 'ready'; readonly summary: PluginManifestPreview }
  | { readonly status: 'degraded'; readonly summary: PluginManifestPreview; readonly reason: string; readonly code: PluginMarketErrorCode }

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

/** Read-only market activation facts for the settings page header. */
export interface MarketStatus {
  /** Whether the market repository is configured (not idle). */
  readonly configured: boolean
  /** Canonical repository root, or null while the market is idle. */
  readonly repositoryPath: string | null
}

/**
 * Checkout kind an install analysis can classify a candidate into. Mirrors
 * the host analyzer vocabulary (see plugin-market-host analyze.ts) as a
 * client-safe literal union so reviews can carry it across the wire.
 */
export type MarketCheckoutKind = 'plugin' | 'skills' | 'preset' | 'tooling' | 'other'

/**
 * Smart-install analysis verdict attached to a review when the candidate
 * checkout is not an installable dsh plugin. `installable` is always false on
 * this shape (an installable plugin carries no analysis field); `kind` tells
 * the UI which refusal copy to show and `reason` is the user-facing model
 * rationale.
 */
export interface PluginInstallReviewAnalysis {
  readonly installable: false
  readonly kind: MarketCheckoutKind
  readonly reason: string
}

/** One pre-download review of a candidate GitHub plugin repository. */
export interface PluginInstallReview {
  /** Validated `owner/repo` slug of the reviewed repository. */
  readonly repository: string
  /**
   * Ref kind the review was minted for. V2 reviews carry `'branch'`/`'tag'`
   * and a key unique to the `(owner, repo, ref-kind, ref)` tuple, so a branch
   * and a tag of the same name review (and later install) independently.
   * Absent on legacy default-branch reviews (the caller provided no refKind),
   * whose key keeps the pre-v2 `gh-owner-repo` convention and stays
   * compatible with old records that carry no ref kind.
   */
  readonly refKind?: GithubRefKind
  /** Stable loader-safe key derived from the slug (e.g. `gh-owner-repo`). */
  readonly key: PluginMarketKey
  /** Manifest summary (ready) or repository-metadata fallback (degraded). */
  readonly preview: PluginPreviewOutcome
  /** Whether a record already exists for this key (an overwrite update). */
  readonly exists: boolean
  /** Whether installing again would overwrite an existing checkout. */
  readonly overwrite: boolean
  /** The existing record when `exists` is true, otherwise null. */
  readonly existing: PluginMarketRecord | null
  /** Single-use confirmation token minted for this review. */
  readonly confirmToken: string
  /** ISO-8601 expiry of the confirmation token. */
  readonly expiresAt: string
  /**
   * Smart-install analysis verdict, present only when the review classified
   * the candidate as not installable (skills/preset/tooling/other, or a plugin
   * needing a build first). Absent on standard npm plugins (no analysis ran)
   * and on candidates the analysis considered installable.
   */
  readonly analysis?: PluginInstallReviewAnalysis
}

/** Outcome of a confirmed install. */
export interface PluginInstallOutcome {
  readonly key: PluginMarketKey
  /** True when the install replaced an already-managed checkout. */
  readonly overwritten: boolean
  readonly record: PluginMarketRecord
  /** Absolute checkout directory of the installed plugin. */
  readonly checkoutDir: string
}

/**
 * Aggregated read-only detail of one remote GitHub repository, served by the
 * repositoryDetail channel method (metadata, branch/tag name listings and the
 * raw README fetched in parallel). README is null when the repository has no
 * README; every other query failure fails the whole call.
 */
export interface RepositoryDetail {
  /** Validated `owner/repo` slug of the repository. */
  readonly repository: string
  readonly name: string
  readonly description: string | null
  /** Stargazer count. */
  readonly stars: number
  /** ISO-8601 last-push/update timestamp, when the API reported one. */
  readonly updatedAt: string | null
  /** Browser URL of the repository. */
  readonly url: string
  /** Clone URL used by the install pipeline. */
  readonly cloneUrl: string
  /** Default branch reported by the API (fallback 'main'). */
  readonly defaultBranch: string
  /** Branch names of the repository (may be empty). */
  readonly branches: readonly string[]
  /** Tag names of the repository (may be empty). */
  readonly tags: readonly string[]
  /** Raw Markdown of the repository README, or null when it has none. */
  readonly readme: string | null
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
 * Structured payload carried by smart-install analysis wire failures. The
 * human-readable analysis rationale travels in the Remote `message` (it is
 * user-facing); `reason` is the same text as structured data for consumers
 * that render the failure without parsing the message.
 */
export interface MarketAnalysisErrorDetails {
  readonly reason?: string
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
    'record/invalid': MarketRemoteErrorDetails
    'github/auth': {}
    'github/rate-limit': {}
    'github/network': {}
    'github/not-found': {}
    'github/bad-response': {}
    'github/bad-request': {}
    'install/dir-exists': MarketRemoteErrorDetails
    'install/dir-in-use': MarketRemoteErrorDetails
    'install/entry-missing': MarketRemoteErrorDetails
    'install/package-invalid': MarketRemoteErrorDetails
    'install/git-failed': {}
    'install/deps-failed': {}
    'install/io': MarketRemoteErrorDetails
    'gate/consent-required': { readonly key?: string }
    'market/idle': {}
    'market/not-found': { readonly key: string }
    'market/protected': { readonly key?: string }
    'market/confirm-required': { readonly key: string }
    'market/confirm-invalid': { readonly key: string }
    'market/confirm-expired': { readonly key: string }
    'market/load-failed': { readonly key: string }
    'market/bad-request': {}
    'market/llm-unconfigured': {}
    'market/llm-failed': {}
    'market/llm-bad-output': MarketAnalysisErrorDetails
    'market/io': MarketRemoteErrorDetails
    'market/unsupported-skills': MarketAnalysisErrorDetails
    'market/unsupported-preset': MarketAnalysisErrorDetails
    'market/unsupported-build': MarketAnalysisErrorDetails
    'market/unsupported-other': MarketAnalysisErrorDetails
  }
}
