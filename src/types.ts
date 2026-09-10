/**
 * Cross-face shared type home for the plugin market.
 *
 * Compiled under BOTH the Host and the Client leaf so each face's cordis
 * Context declaration merges stay inside its own Program. The file carries
 * runtime values as well as types — the classification vocabulary and its
 * guard/default are imported *by value* from both faces (the client needs the
 * default tag to label records) — so `import type` is required only for
 * type-only cross-boundary consumers; the values exported here are
 * dependency-free (no `node:*`, no harness imports) and therefore safe for the
 * browser bundle. Adding any non-trivial runtime import here would leak into
 * the client bundle, so keep them free of side effects.
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
 * Classification tag of one installed plugin record — what the checkout turned
 * out to be once it was filed into the local source repository.
 *
 * - `plugin`: the checkout carries a runnable entry the loader can register
 *   (`record.entry` non-null).
 * - `skills`: an agent skills/instruction/capability pack (analyzer verdict).
 * - `other`: anything else — a configuration preset, tooling, documentation, an
 *   unclassified checkout, or a checkout whose runnable entry could not be
 *   resolved. Filing is never blocked by it: the record is kept, the checkout
 *   stays on disk, and only the loader registration is withheld (entry null).
 *
 * Only these three labels are persisted; the richer analyzer vocabulary
 * (preset/tooling/…) is folded into `other` by the host analyzer.
 */
export type PluginMarketClassification = 'plugin' | 'skills' | 'other'

/**
 * Default classification of a record that carries none (legacy pre-tag files).
 * Kept as the single source of the backward-compatible default: old records
 * were only ever created for standard, entry-resolving plugins.
 */
export const DEFAULT_PLUGIN_MARKET_CLASSIFICATION: PluginMarketClassification = 'plugin'

/**
 * Narrow whether an untrusted value is a persisted classification tag (used by
 * the host record store; the shared default above is never a validation hole).
 */
export function isPluginMarketClassification(value: unknown): value is PluginMarketClassification {
  return value === 'plugin' || value === 'skills' || value === 'other'
}

/**
 * Why one managed record cannot be registered as a live loader entry.
 * `null` means it can (see {@link isPluginRecordLoadable}).
 */
export type PluginRecordNotLoadableReason = 'classification' | 'entry'

/**
 * Reason one record is NOT loadable, or null when it is. The check is the
 * single source of the control layer's load gate (host `setEnabled` refusal and
 * the rebuild/sync row guard) and of the `loadable` flag the presentation
 * layers render:
 *
 * - a persisted classification other than `plugin` (skills pack / other
 *   checkout) has no runnable entry by definition — `'classification'`;
 * - a record whose classification is `plugin` (or absent, read as the
 *   backward-compatible {@link DEFAULT_PLUGIN_MARKET_CLASSIFICATION} default)
 *   but whose `entry` is null has nothing to import — `'entry'`.
 *
 * The `'entry'` case deliberately covers legacy records written before the
 * entry metadata existed: an entry-less record can only be loaded through the
 * historical conventional `index.js` fallback, which the gate no longer
 * silently trusts. Such a record is enabled again by re-downloading it (the
 * install then resolves and stores the real entry) instead of by enabling a row
 * that would import a file nobody verified.
 */
export function recordNotLoadableReason(
  record: Pick<PluginMarketRecord, 'classification' | 'entry'>,
): PluginRecordNotLoadableReason | null {
  const classification = record.classification ?? DEFAULT_PLUGIN_MARKET_CLASSIFICATION
  if (classification !== 'plugin') return 'classification'
  return record.entry === null ? 'entry' : null
}

/**
 * Whether one managed record can be registered as a live loader entry: only a
 * `plugin`-classified record with a resolved runnable entry is loadable.
 * Enablement of anything else is refused by the control layer with the stable
 * `market/not-loadable` code instead of creating a row that could never load.
 */
export function isPluginRecordLoadable(
  record: Pick<PluginMarketRecord, 'classification' | 'entry'>,
): boolean {
  return recordNotLoadableReason(record) === null
}

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
  /**
   * Reserved for wire compatibility: the install pipeline no longer refuses a
   * checkout without a runnable entry (it files it with a null entry and a
   * `skills`/`other` classification), so nothing in this package throws this
   * code today. Kept because it is part of the published code union that
   * consumers and older records/wire payloads may still reference.
   */
  | 'install/entry-missing'
  /**
   * Produced by `readCheckoutManifest` (host/market/install.ts) when a caller
   * that requires a usable package.json finds it missing, unreadable, not JSON
   * or not a JSON object. The install pipeline itself never throws it — it uses
   * the tolerant `readCheckoutManifestState` and files the checkout instead.
   */
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
  /**
   * Wire-compatibility markers of the retired smart-install refusal vocabulary.
   * No longer produced by anything in this package: the analyzer folds kinds
   * into the persisted classification labels (`skills`/`other`) instead of
   * refusing, and the install pipeline files such checkouts rather than
   * rejecting them. Kept because they remain part of the published code union
   * and the wire `RemoteErrorDetailsMap` consumers may still switch on.
   * Mapping (historical → current): `unsupported-skills` → `skills`;
   * `unsupported-preset`/`unsupported-other` → `other`; `unsupported-build`
   * (a plugin whose entry was not built yet) → `other` with a null entry.
   */
  | 'market/unsupported-skills'
  | 'market/unsupported-preset'
  | 'market/unsupported-build'
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
   * Null means there is no runnable entry to register: either the record
   * predates entry metadata (the control service then falls back to the
   * conventional `index.js` entry and surfaces a load failure if the file does
   * not exist) or the checkout was deliberately filed without one (a skills
   * pack, or a plugin whose entry is not built yet) — the record then carries
   * `classification: 'other'`/`'skills'` and the control layer decides whether
   * to register a loader row at all.
   */
  readonly entry: string | null
  /**
   * Classification tag of the checkout (see
   * {@link PluginMarketClassification}). Absent on records written before the
   * tag existed: consumers must read such records as
   * {@link DEFAULT_PLUGIN_MARKET_CLASSIFICATION} (`'plugin'`) instead of
   * inferring anything from the absence.
   */
  readonly classification?: PluginMarketClassification
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
  /**
   * Whether this record may be enabled at all: only a `plugin`-classified
   * record with a resolved entry is loadable (see
   * {@link isPluginRecordLoadable}). Consumers use it to disable the enable
   * switch; the host refuses an enable attempt of a non-loadable record with
   * the stable `market/not-loadable` code, so the flag and the refusal can
   * never disagree.
   */
  readonly loadable: boolean
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

/**
 * Stable kind of one install-review note: why the reviewed checkout is not
 * expected to become a loadable plugin.
 *
 * CONTRACT FOR CONSUMERS (the UI half): the Host never ships user-facing prose
 * for a note. Render the copy for `kind` from your own locale dictionary:
 *
 * - `'classified'` → the checkout is not a plugin; pair it with
 *   `PluginInstallReview.classification` (e.g. "will be tagged as SKILLS") and
 *   optionally show `note.text` as a secondary analyzer detail;
 * - `'entry-missing'` → no runnable entry is present; the download still runs,
 *   the record ends up not loadable (see `recordNotLoadableReason`);
 * - `'analysis-unavailable'` → the smart-install analyzer could not classify
 *   the checkout; show the model-configuration guidance (the same copy the
 *   preview's `market/llm-unconfigured` failure uses) and `note.text` is
 *   absent.
 *
 * The optional detail fields carry only untrusted, engine-supplied specifics
 * (analyzer rationale, expected entry path) — never Host copy.
 */
export type MarketInstallNoteKind =
  /** The checkout is not a plugin at all (skills pack / preset / tooling / …). */
  | 'classified'
  /** No runnable entry was found inside the checkout. */
  | 'entry-missing'
  /** The smart-install analyzer could not classify the checkout (unconfigured or failed). */
  | 'analysis-unavailable'

/**
 * Structured, localizable note of one install review. This — not the legacy
 * `entryNote` string — is the note channel for user-visible copy: a consumer
 * maps `kind` onto its own dictionary and may render the optional `text` (an
 * analyzer rationale or a resolved entry path) as a secondary detail.
 */
export interface MarketInstallNote {
  readonly kind: MarketInstallNoteKind
  /**
   * Engine-supplied detail: the analyzer's rationale for a classified
   * checkout, or the entry path that could not be found. Untrusted
   * model/third-party text, shown at most as a secondary detail — never as the
   * primary UI copy and never as the sole content of a status line.
   */
  readonly text?: string
  /** Entry path the checkout was expected to carry, when one is known. */
  readonly entry?: string
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
   * Classification the install of this review is PREDICTED to file the
   * checkout under (see {@link PluginMarketClassification}). The prediction is
   * only a hint: the download inspects the real checkout and the entry probe
   * always wins, so a checkout carrying a runnable entry is filed as `plugin`
   * whatever this field predicted, and the authoritative tags come back on
   * {@link PluginInstallOutcome}.
   *
   * - `plugin` — the remote preview showed a standard npm plugin checkout, so a
   *   runnable entry is expected;
   * - `skills` / `other` — the analysis classified the checkout (skills pack /
   *   preset / tooling / documentation), or no usable analysis was available at
   *   all. Installing it is NOT blocked: the checkout is downloaded and filed
   *   with the resolved tag (and a null entry when it really has none), and only
   *   the loader registration is withheld.
   */
  readonly classification: PluginMarketClassification
  /**
   * Whether the install of this review is expected to produce a checkout
   * needing a build step before it becomes loadable (the analysis judged it a
   * dsh plugin whose entry is not present yet). Present only when true.
   *
   * NOT PRODUCED BY THE PRODUCTION ASSEMBLY (test-only seam): the flag needs an
   * entry probe at review time, and the production preview reads only the
   * remote manifest — nothing can probe a checkout that has not been downloaded
   * yet (see `MarketSourceDeps.analysisEntryProbe`). It is populated only when
   * previewInstall runs an analysis over an injected probe, i.e. in specs. The
   * authoritative "this checkout has no runnable entry" signal is
   * `classification`/`entry` of {@link PluginInstallOutcome} and of the managed
   * record (`recordNotLoadableReason`), which consumers already render as the
   * not-loadable state.
   */
  readonly buildRequired?: boolean
  /**
   * Diagnostic note of a review that is not expected to become a loadable
   * plugin. DEBUG/LOG-ONLY: when present it holds the analyzer's own rationale
   * (third-party/model text). It is NOT a UI copy channel — render
   * {@link note} (stable kind + dictionary lookup) instead, and never surface
   * this string as user-visible copy.
   */
  readonly entryNote?: string
  /**
   * Structured, localizable note of the review — THE UI CHANNEL for "why this
   * checkout will not be a plugin" copy (see {@link MarketInstallNote} and
   * {@link MarketInstallNoteKind} for the exhaustive kind list and the
   * per-kind rendering contract). Present whenever the checkout is not
   * expected to become a loadable plugin, including the "no usable analysis"
   * case; unlike {@link entryNote} it never carries Host-authored prose.
   */
  readonly note?: MarketInstallNote
  /**
   * Smart-install analysis verdict, present only when the review classified
   * the candidate as not installable (skills/preset/tooling/other, or a plugin
   * needing a build first). Kept for consumers that render the richer analyzer
   * vocabulary; {@link classification} is the persisted tag the install files.
   * Absent on standard npm plugins (no analysis ran) and on candidates the
   * analysis considered installable.
   */
  readonly analysis?: PluginInstallReviewAnalysis
}

/**
 * Outcome of a confirmed install. The classification/entry fields mirror what
 * the host pipeline actually filed (the checkout inspection, not the review
 * prediction), so a consumer can show the real result without re-reading the
 * record.
 *
 * UI CONTRACT: render {@link classification} + {@link entry} (+ the managed
 * record's `loadable` state) — those are stable, dictionary-friendly facts.
 * {@link entryNote} is a DEBUG/LOG-ONLY diagnostic string (host pipeline prose,
 * English) and must never be rendered as user-visible copy.
 */
export interface PluginInstallOutcome {
  readonly key: PluginMarketKey
  /** True when the install replaced an already-managed checkout. */
  readonly overwritten: boolean
  readonly record: PluginMarketRecord
  /** Absolute checkout directory of the installed plugin. */
  readonly checkoutDir: string
  /** Classification the checkout was actually filed under. */
  readonly classification?: PluginMarketClassification
  /** Runnable entry that was registered, or null when the checkout has none. */
  readonly entry?: string | null
  /**
   * DEBUG/LOG-ONLY diagnostic of a null entry (which resolved entry was missing,
   * or that the checkout manifest was unreadable). Host-authored English prose
   * for operators and test assertions: never render it as user-visible copy —
   * UI copy comes from the review's structured note and from
   * `classification`/`entry` above.
   */
  readonly entryNote?: string | null
  /** Whether the dependency step (`pnpm install`) actually ran. */
  readonly dependenciesInstalled?: boolean
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
  /**
   * Machine-readable sub-reason of a failure, when the code alone is not
   * specific enough (`market/not-loadable` carries `'classification'` or
   * `'entry'`; smart-install failures carry the analyzer rationale).
   */
  readonly reason?: string
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
  | 'market/not-loadable'
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
    'market/not-loadable': { readonly key: string; readonly reason?: string }
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
