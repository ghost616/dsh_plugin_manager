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
 *
 * Two external packages are referenced TYPE-ONLY, so neither reaches the
 * browser bundle: `@deepseek-ai/dsh-typert-protocol` (whose
 * `RemoteErrorDetailsMap` this file augments) and `@deepseek-ai/dsh-credentials`
 * (whose branded `CredentialRef` names the GitHub access-token reference).
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
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
  /**
   * This deployment has no credential seam mounted (`ctx.credentials` absent),
   * so the GitHub access token can neither be read nor written: the token
   * surface reports one stable code for both halves instead of inventing a
   * second, and never silently degrades to the launch environment (that would
   * make a "saved" token look lost).
   */
  | 'github/token-unavailable'
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
/* GitHub access-token contract (credential seam)                            */
/* ------------------------------------------------------------------------ */

/**
 * Source layer currently supplying the GitHub access token, as reported by the
 * credential seam's `CredentialInfo.source`. It is provider-defined, hence an
 * OPEN vocabulary: the four members below are what the shipped local provider
 * reports, and a consumer renders a generic label for anything else (including
 * a missing field) instead of failing on it — the same soft-branch discipline
 * the wire error details follow.
 *
 * - `env` — the launch environment of the dsh process (`DSH_GITHUB_TOKEN` /
 *   `GITHUB_TOKEN` exported before it started). Nothing a surface can write
 *   replaces it, so it is the one read-only layer;
 * - `file` — the credential store the active provider manages (writable);
 * - `project-env` — the invoking project's `.env` file (writable: a stored
 *   value becomes the effective one and shadows it);
 * - `user-env` — the harness home `.env` file, ranked below the project one.
 *
 * Precedence belongs to the provider, not to this contract: `env` outranks the
 * stored `file`, which outranks `project-env`, which outranks `user-env`.
 */
export type GitHubTokenSource = 'env' | 'file' | 'project-env' | 'user-env' | (string & {})

/**
 * Read-only status of the GitHub access token this deployment sends with its
 * API requests — safe for a settings surface and for the wire, because it has
 * no slot a secret could ride in: the only value-derived field it carries is a
 * redacted display mask the host builds (see {@link GitHubTokenStatus.maskedHint}),
 * and the plaintext never leaves the host.
 *
 * The three state facts mirror the credential seam (`ctx.credentials.describe`)
 * instead of being re-derived here, so a provider change reaches the surface
 * without a second source of truth; the effective reference is the one fact the
 * seam cannot know, because preferring one name over the other is the market's
 * own rule.
 */
export interface GitHubTokenStatus {
  /** Whether resolving the effective reference would currently return a value. */
  readonly configured: boolean
  /**
   * Layer currently supplying the token, absent while unconfigured (an absent
   * field, never a placeholder string). See {@link GitHubTokenSource}.
   */
  readonly source?: GitHubTokenSource
  /**
   * Whether the active provider can write the effective reference. `false` is
   * the read-only launch environment: a write there would appear to succeed
   * while the shadowing value kept being resolved, so the surface offers no
   * save action for it (clearing stays possible wherever a stored value exists
   * beneath it).
   */
  readonly writable: boolean
  /**
   * The reference the market resolves: the first of the two names that
   * currently has a value — `DSH_GITHUB_TOKEN` preferred, `GITHUB_TOKEN`
   * second, so a deployment setting both is unambiguous — and the preferred
   * head while neither has one, so even an unconfigured deployment reports the
   * name a write would target. The name is the credential seam's branded
   * reference and travels the wire as a plain string; it is what a surface
   * renders next to the state ("configured, from DSH_GITHUB_TOKEN").
   */
  readonly ref: CredentialRef
  /**
   * Redacted, display-only hint of the resolved token — a mask the HOST builds
   * from the value, never the value itself. The field is optional, and its
   * absence is the whole signal: it is omitted whenever there is no mask to show
   * (the reference is unconfigured, or the value could not be read), so there is
   * never a placeholder string or an empty-string stand-in for "unknown".
   *
   * Three properties define this field:
   *
   * - **It is a deliberate deviation from the credential seam's own habit.** dsh
   *   keeps every credential surface boolean-only: `ctx.credentials.describe`
   *   answers configured/source/writable, and no wire method of the seam ever
   *   returns a value. This single, narrow value-derived string is the exception
   *   a settings surface needs in order to show *which* token is in effect
   *   beyond a bare "yes".
   * - **It carries the mask and nothing else.** The plaintext token never
   *   travels through this field, through any other field of this shape, or
   *   through any other wire field: the producer reads the value host-side
   *   (through the seam) and only the derived string ever leaves the host.
   * - **Its dot run is fixed at eight**, independent of the real token's length,
   *   so the mask cannot leak how long the value is. The prefix and the four
   *   trailing characters described below are the only characters ever taken
   *   from it.
   *
   * Mask rule (computed by the control layer; stated here so a consumer knows
   * exactly what it is rendering): the value's opening up to and including its
   * first underscore — capped at 12 characters, and omitted entirely when the
   * value has no underscore — then exactly eight dots, then the last four
   * characters.
   *
   * Two self-protection conditions return the eight dots ALONE instead, with no
   * character of the value surviving at all — nothing a reader could spell back
   * out of a mask is a mask:
   *
   * - a value of eight characters or fewer. This length rule stands on its own
   *   and is not conditioned on whether the kept characters would cover the
   *   value: such a value would give most of itself away whichever runs of it
   *   were kept, so the dots come back regardless;
   * - a value whose prefix plus its kept four trailing characters already cover
   *   the whole value. This second condition is NECESSARY and not a restatement
   *   of the first: the first underscore may be the value's LAST character, so
   *   the prefix alone can be the entire value (`secretok_` would otherwise
   *   render as `secretok_••••••••tok_`, echoing every character it has), and
   *   whenever the kept runs together spell the value out the result is a fully
   *   reversible pseudo-mask rather than a mask.
   *
   * A consumer renders the string verbatim and never re-derives, recomputes or
   * trims it.
   */
  readonly maskedHint?: string
}

/**
 * Answer of one committed token write. Saving a value and clearing one share
 * it: they differ only in the status reported afterwards (`configured`
 * true/false), so a surface needs neither a second shape nor a re-read — the
 * status is the post-write fact, never an echo of the caller's intent.
 *
 * No secret travels here, so the result may cross the Remote wire.
 */
export interface GitHubTokenUpdateResult {
  /** Status re-read after the write committed. */
  readonly status: GitHubTokenStatus
  /**
   * Whether the write dropped the token the market had memoized, so the next
   * GitHub request resolves the new value. A REPORT, not a branch: a surface
   * shows "saved" either way, and `false` means only that nothing was memoized
   * at that moment — never that the previous value is still in effect.
   */
  readonly cacheCleared: boolean
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
  /**
   * HOST PROJECTION of the enable gate: whether this record may be enabled at
   * all. Only a `plugin`-classified record with a resolved entry is loadable,
   * so this flag and the host's `market/not-loadable` refusal share one source
   * ({@link isPluginRecordLoadable} / {@link recordNotLoadableReason}) and can
   * never disagree. The shipped UI may read it directly, or recompute the same
   * verdict from the record with {@link recordNotLoadableReason} (it does the
   * latter, so it can render the specific reason); either way the host refuses
   * an enable attempt of a non-loadable record with `market/not-loadable`.
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
 * LEGACY / WIRE-COMPAT analytical verdict of one review. `kind` is the host
 * analyzer's own vocabulary (see `MarketCheckoutKind`) and `reason` is the
 * analyzer's rationale for it.
 *
 * NOT A UI CONTRACT, in either direction:
 *
 * - the UI must NOT render a refusal from this field (there is no refusal to
 *   render — a non-plugin checkout stays downloadable); if it wants the
 *   analyzer's rationale as a secondary detail it takes it from
 *   {@link MarketInstallNote.text}, the untrusted-prose channel;
 * - `reason` is analyzer-supplied text (model/third-party), never Host copy and
 *   never something to render as the primary status line.
 *
 * The shape is kept only because it is part of the shipped wire/type surface:
 * a review may carry it, and consumers predating {@link MarketInstallNote} may
 * still read it. No source in this package consumes it.
 */
export interface PluginInstallReviewAnalysis {
  readonly installable: false
  readonly kind: MarketCheckoutKind
  /** Analyzer rationale for `kind` (model/third-party text; not UI copy). */
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
   * LEGACY / WIRE-COMPAT analyzer verdict, present only when an analysis ran
   * over the candidate. It is kept for the shipped wire surface and for
   * consumers older than {@link MarketInstallNote}; no source in this package
   * reads it, and the UI MUST NOT render "not installable" copy from it — the
   * documented UI channel is {@link note} (stable kind + dictionary lookup),
   * with {@link classification} as the persisted tag the install files and
   * {@link buildRequired} as the (test-only) build hint. `reason` inside it is
   * analyzer text, not Host copy.
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

/**
 * Closed, cross-face vocabulary of the download/commit `details.reason` values.
 *
 * These five strings are what the control layer puts on a failed
 * `prepareDownload` / `classifyDownload` / `commitDownload` handle or commit, so
 * a consumer can branch on *why* it failed. They are declared here as a
 * compile-time vocabulary, which means exactly this:
 *
 * - this file exports a TYPE for the vocabulary and no vocabulary constant
 *   object that an outside caller could import; the strings themselves are
 *   produced exclusively by the host control layer, which keeps its own
 *   `DOWNLOAD_REASON_*` constants as the single runtime source of truth;
 * - the strings do reach the client bundle all the same, written out as the
 *   compared literals of the consumer's soft branches (the web half tests
 *   `reason === 'commit-before-swap'`, and so on). That is intended: a literal
 *   comparison is how a consumer names the vocabulary value it handles, it is
 *   not a leaked runtime dependency on the producer;
 * - {@link MarketRemoteErrorDetails.reason} is NOT narrowed to this union: see
 *   the soft-branch contract there.
 *
 * The control layer is expected to keep
 * `satisfies`-checking its constants against this union, which is what makes
 * "the host produces exactly what the shared document promises" a compile-time
 * fact instead of a convention.
 */
export type MarketDownloadFailureReason =
  /** The handle was never staged (or is not one this instance knows): re-review and prepare. */
  | 'download-unknown'
  /** The staged handle was swept after its TTL: re-review and prepare again. */
  | 'download-expired'
  /** The commit failed BEFORE the swap: nothing moved, the same handle can retry. */
  | 'commit-before-swap'
  /** The commit failed AFTER the swap and no record exists for the new checkout. */
  | 'repair:checkout-committed-no-record'
  /** The commit failed AFTER the swap while the previous record is still in place. */
  | 'repair:checkout-committed-record-stale'

/**
 * Every value `details.reason` may carry on a market wire failure.
 *
 * {@link MarketDownloadFailureReason} is the closed download/commit family; the
 * open tail covers values that are *not* a closed cross-face vocabulary - the
 * `market/not-loadable` discriminators (`'classification'` / `'entry'`) and the
 * smart-install analyzer's own rationale text, both produced by the host and
 * both intentionally open. An unrecognized string is the normal case for a
 * consumer of an older or newer host, which is why the field stays optional.
 */
export type MarketRemoteReason = MarketDownloadFailureReason | (string & {})

/** Structured payload carried by every market wire failure (opt-in fields). */
export interface MarketRemoteErrorDetails {
  readonly key?: string
  readonly path?: string
  /**
   * Machine-readable sub-reason of a failure, when the code alone is not
   * specific enough. **Optional soft-branch evidence**, never a closed union:
   * a consumer branches on the values it knows and falls back to a generic
   * presentation for anything else (including a missing field). Unknown values
   * are expected - the payload may come from a different version.
   *
   * Values in use:
   *
   * - {@link MarketDownloadFailureReason} - the download/commit family, e.g. a
   *   `market/not-found` on a download/commit handle carries `'download-expired'`
   *   versus `'download-unknown'` (swept by TTL vs never staged), and an
   *   `install/io` commit failure carries `'commit-before-swap'` (nothing moved;
   *   retry the same handle) or a `repair:` value (the swap DID complete and only
   *   the record write failed - see below);
   * - `'classification'` / `'entry'` - which half of the enable gate refused a
   *   `market/not-loadable` record;
   * - the smart-install analyzer's rationale on `market/llm-*` /
   *   `market/unsupported-*` failures (its `MarketAnalysisErrorDetails` channel
   *   is the primary home; this field mirrors it where the code also carries
   *   these details).
   *
   * ## The `repair:` pair (why the reason matters more than the code)
   *
   * Both repair values arrive as code `install/io`, the same code a pre-swap
   * commit failure uses, so the reason is the ONLY discriminator:
   *
   * - `repair:checkout-committed-no-record` - the new checkout is in place and
   *   nothing describes it; a human must remove it before a clean retry;
   * - `repair:checkout-committed-record-stale` - the new checkout is in place
   *   while the previous record still describes the old one; re-downloading is
   *   an idempotent overwrite that re-syncs the record, so no hand cleanup is
   *   needed.
   *
   * On both, the swapped checkout directory travels as {@link path}.
   *
   * Note the reverse edge: the host also attaches `swapCompleted` /
   * `checkoutDir` to its own error details, but `path` is where `checkoutDir`
   * lands on the wire and `swapCompleted` is NOT forwarded - a consumer never
   * gets a boolean swap flag, which is exactly why the repair reasons exist.
   */
  readonly reason?: MarketRemoteReason
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
 * Structured payload of a `github/rate-limit` wire failure — what a consumer
 * needs to render "wait N minutes" instead of a bare "try later".
 *
 * Both fields are OPTIONAL, so this is a widening of the details shape rather
 * than a new requirement: the empty payload older hosts sent stays valid, and
 * either field may be absent on its own, because GitHub reports a reset instant
 * on `x-ratelimit-reset` and a wait duration on `retry-after` and a throttled
 * response need not carry both. The inherited generic fields (`key`, `path`,
 * `reason`) keep their meaning, so a consumer already branching on them is
 * unaffected.
 */
export interface MarketGitHubRateLimitDetails extends MarketRemoteErrorDetails {
  /**
   * ISO-8601 instant at which the limit resets, when the response reported one
   * (`x-ratelimit-reset`). The wire pins ONE representation deliberately: a raw
   * epoch number would force every consumer to branch on `typeof` before it
   * could format the instant, so a host holding epoch seconds converts once,
   * here.
   */
  readonly resetAt?: string
  /**
   * Suggested wait before retrying, in milliseconds — the `retry-after`
   * duration as reported, or one derived from the reset instant. This is the
   * field a countdown reads; a consumer that finds neither field falls back to
   * its generic "try later" copy.
   */
  readonly retryAfterMs?: number
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

/* ------------------------------------------------------------------------ */
/* Download-phase wire contract (prepare -> classify -> commit)             */
/* ------------------------------------------------------------------------ */

/**
 * Cross-face shapes of the three-phase DOWNLOAD surface, as the host control
 * channel returns them.
 *
 * ## "Download" vs "install" - the vocabulary this file pins down
 *
 * - **download** = fetch the sources into the local repository. The three
 *   phases below are one download: `DownloadPreparation` (cloned into a private
 *   staging directory, nothing filed yet), `DownloadClassification` (the label
 *   decision for that checkout) and `DownloadCommit` (the staged checkout is
 *   swapped into its final location and the record is written, disabled).
 * - **install** = whatever comes after: installing the checkout's dependencies
 *   (`pnpm install`, a separate explicit action) and enabling the plugin
 *   (the loader registration the control layer owns).
 *
 * The split is the reason `dependenciesInstalled` on {@link DownloadCommit} is
 * `false` by contract: **a download never installs dependencies**. A later,
 * explicit install action is what flips that fact.
 *
 * Authoritative source of these shapes is the host control channel
 * (`src/host/control/source.ts`, built on the phases of
 * `src/host/market/install.ts`); the faces consume them from here so a drift
 * cannot hide behind a local mirror.
 */

/**
 * Opaque download handle as it travels the wire.
 *
 * Plain `string` on purpose: the channel is JSON, so the handle is forwarded
 * verbatim, and the host's own branded, process-local `DownloadToken` stays an
 * internal detail of the installer. A handle is **in-memory and never
 * persisted** - it is valid for the process that minted it, and a restart
 * invalidates it (the next prepare cleans the stale staging area).
 */
export type DownloadHandle = string

/** Lifecycle state of one staged download (mirrors the host's phase states). */
export type DownloadStageState =
  /** Cloned and awaiting classification/commit; cancellation is allowed. */
  | 'prepared'
  /** Classified (the label is not stored on the host - the caller keeps it). */
  | 'classified'
  /** Swap + record write finished; the handle is consumed. */
  | 'committed'

/**
 * How one classification attempt finished. `unclassified` (no model available)
 * and `failed` (the model call itself failed) both file the conservative
 * `other` label and keep the checkout, so a model problem never blocks a
 * download.
 *
 * {@link DownloadStageState} and this union are the canonical *names* for the
 * literal unions the host channel spells inline; they expand to exactly the
 * same members, so the wire contract and the host's return shape cannot drift.
 */
export type DownloadClassifyOutcome = 'classified' | 'unclassified' | 'failed'

/**
 * Channel answer of phase 1 (`prepareDownload`): what was cloned, under which
 * handle, and the facts a UI shows for "cloning sources".
 */
export interface DownloadPreparation {
  /** Process-local download handle; never persisted, never reused across restarts. */
  readonly token: DownloadHandle
  /** Stable loader-safe key the eventual record will carry. */
  readonly key: PluginMarketKey
  /** `owner/repo` slug that was cloned. */
  readonly repository: string
  /** V2 ref kind; absent for a legacy default-branch download. */
  readonly refKind?: GithubRefKind
  /** Branch/tag name that was checked out (null for a legacy unpinned clone). */
  readonly ref: string | null
  /** Repository-root-relative checkout location the commit phase will create. */
  readonly localDirName: string
  /** Commit the staged checkout sits at, when resolvable. */
  readonly commit: string | null
  /** ISO-8601 timestamp of the staging start. */
  readonly startedAt: string
  /** Current lifecycle state (see {@link DownloadStageState}). */
  readonly state: DownloadStageState
  /** Whether a record already exists for this key (the commit will overwrite it). */
  readonly overwrite: boolean
}

/**
 * Channel answer of phase 2 (`classifyDownload`).
 *
 * **This phase never fails for a model problem**: an unavailable or failing
 * model yields `outcome: 'unclassified' | 'failed'` with
 * `classification: 'other'`, `unclassified: true` and a human-readable
 * `reason`, so the download keeps its checkout and the label can be corrected
 * later. Only an unknown/expired handle fails the call.
 */
export interface DownloadClassification {
  readonly outcome: DownloadClassifyOutcome
  /** Label to commit: the model's answer, or the conservative `'other'`. */
  readonly classification: PluginMarketClassification
  /**
   * Rationale (untrusted model text, or the host's explanation for why no
   * classification happened); shown at most as a secondary detail.
   */
  readonly reason: string
  /** True when the model could not classify (either `unclassified` or `failed`). */
  readonly unclassified: boolean
  /**
   * Mechanical hint only (never the classifier): whether the resolved entry
   * exists in the checkout. `null` when the checkout has no usable manifest.
   */
  readonly entryPresent: boolean | null
  /** Entry the mechanical probe resolved (checkout-relative), or null. */
  readonly entryHint: string | null
  /** Stable error code of a failed model call (`market/llm-*`, `market/io`). */
  readonly errorCode?: string
}

/**
 * Channel answer of phase 3 (`commitDownload`): the record the download was
 * actually filed as. The checkout has been swapped into its final location and
 * the record written `enabled: false` under the TrustGate `trusted` state; only
 * the loader registration is still withheld (that is the later install/enable
 * action).
 */
export interface DownloadCommit {
  readonly key: PluginMarketKey
  /** Whether an existing checkout for the same key was replaced. */
  readonly overwritten: boolean
  readonly record: PluginMarketRecord
  /** Final absolute checkout directory. */
  readonly checkoutDir: string
  /** Label the checkout was actually filed under. */
  readonly classification: PluginMarketClassification
  /** Registered runnable entry, or null for an entry-less checkout. */
  readonly entry: string | null
  /**
   * Always `false`: the download path never installs dependencies. The fact is
   * kept so a consumer can show "dependencies not installed yet" and a later
   * explicit action can flip it.
   */
  readonly dependenciesInstalled: boolean
  /** Diagnostic note (null on the happy path). */
  readonly note: string | null
}

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
    'github/token-unavailable': {}
    'github/rate-limit': MarketGitHubRateLimitDetails
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
