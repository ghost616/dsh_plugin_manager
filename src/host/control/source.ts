/**
 * Source operations of the market control surface: GitHub search, repository
 * detail (metadata + branches + tags + README), install preview and the
 * double-confirmed install protocol. These reach the local repository only to
 * answer "already managed?" and to run the download; all network and
 * filesystem work is delegated to injectable host-market engines
 * (GitHubMarket / PluginPreviewer / PluginInstaller), keeping this layer free
 * of fetch and subprocess code and fully unit-testable.
 *
 * Classification (never a gate): every review carries the classification the
 * install is predicted to file (`plugin` for a standard npm checkout whose
 * remote manifest was readable; the analyzer's `skills`/`other` tag for an
 * unconventional checkout; `other` when no usable analysis was available) plus
 * a user-facing note when no runnable entry is expected. An unconventional
 * checkout is still downloaded and filed — with its classification and a null
 * entry — instead of being refused; only the loader registration is withheld
 * by the control layer (`market/not-loadable` on enable).
 *
 * Confirmation model (mirrors the requestRemove/confirmRemove pattern):
 * - `previewInstall` reviews the remote manifest, reports the already-managed
 *   / overwrite state and mints a short-lived single-use confirmation token
 *   bound to the reviewed install key — the slug-derived legacy key for a
 *   no-refKind (default-branch) review, or the per-`(owner, repo, ref-kind,
 *   ref)` tuple key for a `refKind: 'branch' | 'tag'` review;
 * - `install` refuses without that token (`market/confirm-required`), rejects
 *   wrong/expired tokens, re-checks the protection list, then runs the host
 *   install pipeline with `confirmed: true` (the host TrustGate stays as the
 *   backend safeguard), persists the reviewed classification and syncs the
 *   newly registered (default-disabled) record into a loader row so
 *   listManaged reflects it immediately.
 */

import { randomBytes } from 'node:crypto'
import type {
  DownloadClassifyOutcome,
  DownloadClassification,
  DownloadCommit,
  DownloadHandle,
  DownloadPreparation,
  DownloadStageState,
  MarketDownloadFailureReason,
  MarketRemoteErrorDetails,
  MarketWireErrorCode,
  GitHubSearchPage,
  PluginInstallReview,
  PluginInstallReviewAnalysis,
  MarketInstallNote,
  PluginMarketClassification,
  PluginMarketKey,
  PluginMarketRecord,
  PluginPreviewOutcome,
  RepositoryDetail,
} from '../../types.ts'
import { isPluginMarketClassification } from '../../types.ts'

// The download-phase wire shapes live in the shared cross-face contract
// (src/types.ts); they are re-exported here because this module is their
// authoritative producer and every control-layer consumer imports them from it.
export type {
  DownloadClassifyOutcome,
  DownloadClassification,
  DownloadCommit,
  DownloadHandle,
  DownloadPreparation,
  DownloadStageState,
} from '../../types.ts'

import type { PluginAnalysisDistribution } from '../market/analyze.ts'
import type { MarketRepository } from '../market/index.ts'
import { parseRepositorySlug, type GitHubRepoMeta } from '../market/github.ts'
import { parsePluginKey, pluginKeyForGithubRef } from '../market/keys.ts'
import { entryModuleName } from './entry-name.ts'
import { REMOVE_CONFIRM_TTL_MS, MarketControlError, type ControlLogger } from './controller.ts'
import type { ProtectionPolicy } from './protect.ts'

/** Search engine surface of the host GitHub client. */
export interface SearchEnginePort {
  search(options: {
    readonly keywords?: string
    readonly perPage?: number
    /** 1-based page; the host layer clamps out-of-range values. */
    readonly page?: number
  }): Promise<GitHubSearchPage>
}

/** Preview engine surface of the host manifest previewer. */
export interface PreviewEnginePort {
  preview(repository: string, signal?: AbortSignal): Promise<PluginPreviewOutcome>
}

/** Detail engine surface of the host GitHub client (repository detail page). */
export interface RepositoryDetailPort {
  /** Repository metadata, resolving its default branch too. */
  repositoryMeta(slug: string, signal?: AbortSignal): Promise<GitHubRepoMeta>
  /** Branch names of the repository (may be empty). */
  branches(slug: string, signal?: AbortSignal): Promise<readonly string[]>
  /** Tag names of the repository (may be empty). */
  tags(slug: string, signal?: AbortSignal): Promise<readonly string[]>
  /**
   * Raw Markdown of the repository README, or null when the repository has no
   * README (a GitHub 404 for the endpoint). Engines that map that 404 into a
   * thrown `github/not-found` are tolerated here as well.
   */
  readme(slug: string, signal?: AbortSignal): Promise<string | null>
}

/** Install engine surface of the host installer (the three-phase download). */
export interface InstallerPort {
  /**
   * Phase 1 — clone the checkout into a private staging directory and mint the
   * opaque handle the later phases (and cancellation) use.
   */
  prepare(input: PrepareDownloadRequest): Promise<PreparedDownload>
  /**
   * Phase 2 — classify the staged checkout. **Never throws** for a model
   * problem: an unavailable/failed model degrades to `other` + `unclassified`
   * (see {@link DownloadPreparationClassify}).
   */
  classify(token: DownloadHandle, options?: DownloadClassifyOptions): Promise<DownloadPreparationClassify>
  /** Phase 3 — swap the staged checkout in and register the record. */
  commit(input: CommitDownloadRequest): Promise<CommittedDownloadFacts>
  /** Cancel a staged download (idempotent; committed/unknown → false). */
  cancel(token: DownloadHandle): Promise<boolean>
}

/** One clone handed to the host pipeline (already TrustGate-confirmed). */
export interface PrepareDownloadRequest {
  readonly repositoryRoot: string
  readonly key: PluginMarketKey
  /** Validated `owner/repo` slug. */
  readonly repository: string
  /** v2 ref kind; absent for a legacy default-branch download. */
  readonly refKind?: 'branch' | 'tag'
  /** Branch/tag name to check out (v2 `ref`, legacy `version` pin). */
  readonly version: string | null
}

/** Facts of one staged download, as the control layer reports them. */
export interface PreparedDownload {
  /** Opaque handle token (process-local, never persisted). */
  readonly token: DownloadHandle
  readonly key: PluginMarketKey
  readonly repository: string
  readonly refKind: 'branch' | 'tag' | undefined
  readonly ref: string | null
  /** Repository-root-relative checkout location the commit will create. */
  readonly localDirName: string
  readonly commit: string | null
  readonly startedAt: string
  readonly state: DownloadStageState
}

/** Options of the classification phase (model endpoint of the assembly). */
export interface DownloadClassifyOptions {
  readonly complete?: (request: DownloadCompletionRequest) => Promise<string>
  readonly provider?: string
  readonly model?: string
}

/** One completion invocation the host classifier performs. */
export interface DownloadCompletionRequest {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly user: string
}

/** Result of the classification phase (never a thrown model failure). */
export interface DownloadPreparationClassify {
  readonly outcome: DownloadClassifyOutcome
  readonly classification: PluginMarketClassification
  /** Engine rationale; untrusted model text or a host explanation. */
  readonly reason: string
  readonly unclassified: boolean
  readonly entryPresent: boolean | null
  readonly entryHint: string | null
  readonly errorCode?: string
}

/** Input of the commit phase. */
export interface CommitDownloadRequest {
  readonly token: DownloadHandle
  /** Label to file (the classification phase's verdict). */
  readonly classification: PluginMarketClassification
  /** Runnable entry to register; absent = the host resolves it mechanically. */
  readonly entry?: string | null
}

/** Facts of one committed download. */
export interface CommittedDownloadFacts {
  readonly record: PluginMarketRecord
  readonly checkoutDir: string
  readonly classification: PluginMarketClassification
  readonly entry: string | null
  /** Always false: the download path never installs dependencies. */
  readonly dependenciesInstalled: boolean
  readonly overwritten: boolean
  /** Diagnostic note (null on the happy path). */
  readonly note: string | null
}

/** Progress callback of one commit retry (test/UI observability). */
export interface DownloadRetryNotice {
  readonly token: DownloadHandle
  readonly key: PluginMarketKey
  /** Stable reason of the first failure that made the retry necessary. */
  readonly reason: string
}

/** Everything the source operations need from its environment. */
export interface MarketSourceDeps {
  /** The active repository, or null while the market is idle. */
  readonly repository: () => MarketRepository | null
  readonly searchEngine: SearchEnginePort
  readonly detailEngine: RepositoryDetailPort
  readonly previewEngine: PreviewEnginePort
  /**
   * Builds the download engine bound to one opened repository.
   *
   * CONTRACT — the returned port MUST be reused for a given repository root:
   * the staged-download handle lives in the port's own in-memory registry, so
   * `prepare` → `classify` → `commit`/`cancel` must reach the SAME port
   * instance. Implementations memoize per root (see the assembly and the test
   * bed); building a fresh engine per call would lose every handle.
   */
  readonly installer: (repository: MarketRepository) => InstallerPort
  readonly protection: ProtectionPolicy
  /** Post-install loader-row sync (production: controller.syncRecordRow). */
  readonly syncRecord: (record: PluginMarketRecord) => Promise<void>
  /** Injectable clock for confirmation expiry (defaults to `new Date`). */
  readonly now?: () => Date
  /** Confirmation validity window; defaults to {@link REMOVE_CONFIRM_TTL_MS}. */
  readonly confirmTtlMs?: number
  /**
   * How long a PREPARED download stays usable before its staging is swept;
   * defaults to {@link DEFAULT_DOWNLOAD_TTL_MS} (ten minutes) and is measured
   * **from the successful prepare**, not from the review.
   *
   * This is deliberately independent of {@link confirmTtlMs}: the review window
   * only gates "may this review start a download?", while this window gates
   * "may this staged checkout still be classified/committed?". A download in
   * progress must therefore never be swept by the (shorter) review window.
   * Configure it at least as long as the review window.
   */
  readonly downloadTtlMs?: number
  /**
   * Optional smart-install analysis engine. Present only when the market
   * Config configured `llm.provider`/`llm.model`; previewInstall then runs the
   * analysis for unconventional checkouts (previews whose manifest is
   * unreadable/absent — no standard npm plugin entry evidence) and carries the
   * resulting classification and rationale on the review. The candidate stays
   * installable either way: without an engine, or when the analysis fails, the
   * review falls back to the conservative `other` classification.
   */
  readonly analysis?: InstallAnalysisEngine
  /**
   * TEST-ONLY SEAM: the preview-time entry probe a spec injects to exercise the
   * analyzer's build-first fold (a plugin answer whose entry is absent becomes
   * `other` + `buildRequired`).
   *
   * The production assembly deliberately injects none: the preview only reads
   * the remote manifest, so nothing can probe the candidate checkout before it
   * is downloaded. `PluginInstallReview.buildRequired` is therefore unreachable
   * in production — the authoritative "no runnable entry" signal is the
   * classification/entry of the install outcome and of the managed record
   * (`recordNotLoadableReason`), which the UI already renders as the
   * not-loadable state.
   */
  readonly analysisEntryProbe?: (repository: string, relativeEntry: string) => boolean | Promise<boolean>
  /** Optional structured logger. */
  readonly logger?: ControlLogger
}

/**
 * One smart-install analysis of an unconventional candidate. The engine
 * classifies the checkout into the persisted tag vocabulary
 * (`plugin` | `skills` | `other`) and reports the entry it found (if any);
 * `null` means the model judged the checkout an installable plugin without a
 * classification of its own. Neither answer blocks the install.
 */
export interface InstallAnalysisEngine {
  /**
   * Classify one candidate whose remote preview showed no readable manifest.
   * @param request - the candidate slug, the preview outcome that marked it
   *   unconventional, and the optional entry probe the engine should consult
   *   (see `MarketSourceDeps.analysisEntryProbe`; without one the engine
   *   reports no `buildRequired`).
   * @returns the classification distribution of the checkout, or null when
   *   the model judged it a standard installable plugin.
   * @throws MarketError `market/llm-unconfigured` when the analysis engine
   *   exists but no llm provider/model is configured; `market/llm-failed` /
   *   `market/llm-bad-output` on model failures. The source layer treats every
   *   failure as "no classification available" and reviews the candidate with
   *   the conservative `other` tag (never a blocked install).
   */
  analyze(request: {
    readonly repository: string
    readonly preview: PluginPreviewOutcome
    /**
     * Answers whether the named checkout-relative entry exists. The engine
     * forwards it to the analyzer, so a plugin whose entry is not present yet
     * resolves to `other` + `buildRequired` instead of a loadable `plugin`.
     *
     * TEST-ONLY SEAM: the production assembly never supplies one (see
     * `MarketSourceDeps.analysisEntryProbe`), so `buildRequired` is unreachable
     * in production — it exists so specs can drive the analyzer's build-first
     * fold. A future production source of entry evidence (a probe over an
     * already-downloaded checkout) would plug in here.
     */
    readonly hasFile?: (relativeEntry: string) => boolean | Promise<boolean>
  }): Promise<PluginAnalysisDistribution | null>
}

/**
 * One open review confirmation, keyed by the derived plugin key.
 *
 * Short-lived and single use: it answers "may this review start a download?"
 * and is consumed by {@link MarketSourceOperations.prepareDownload}. Its window
 * ({@link MarketSourceDeps.confirmTtlMs}) has nothing to do with the download
 * window a successful prepare opens afterwards.
 */
interface ReviewEntry {
  /** Single-use preview confirmation presented to `prepareDownload`. */
  readonly token: string
  /** Expiry of the confirmation (the review's own TTL). */
  readonly expiresAt: number
  /** Ref name the review pinned, honoured when the caller omits the version. */
  readonly version: string | null
  /**
   * Classification the review PREDICTED for this checkout. The download never
   * files it: the classification phase decides the real tag and the commit
   * phase takes it as input, so this stays a hint for the review UI only.
   */
  readonly classification: PluginMarketClassification
  /** Review note rendered on the review (absence = a runnable entry is expected). */
  readonly note: MarketInstallNote | null
  /** What a download started from this review has to stage. */
  readonly recipe: DownloadRecipe
}

/**
 * One in-flight staged download.
 *
 * The map holding these entries is keyed by the CALLER handle — the token
 * `prepareDownload` handed out, which stays valid for the entry's whole life.
 * {@link DownloadEntry.token} is the HOST staging handle that is live right now:
 * the two are the same until a pre-swap commit failure makes the host drop its
 * own handle, after which the next host-bound phase (`classifyDownload` or
 * `commitDownload`) re-stages from {@link DownloadEntry.recipe} and adopts the
 * replacement (see {@link DownloadEntry.restage}).
 *
 * Process-local and in memory only: the host handle it wraps is never
 * persisted, never replayed after a restart and never shared across requests.
 * Its deadline is counted from the successful prepare
 * ({@link MarketSourceDeps.downloadTtlMs}) and is deliberately independent of
 * the review window that started it.
 */
interface DownloadEntry {
  /** Host staging handle usable right now (equal to the caller handle until a re-stage). */
  readonly token: DownloadHandle
  /** Stable key the eventual record will carry. */
  readonly key: PluginMarketKey
  /** Expiry of the staged download, counted from the successful prepare. */
  readonly expiresAt: number
  /** Recipe the handle was prepared from, so a retry can re-stage it. */
  readonly recipe: DownloadRecipe
  /**
   * Set when a commit failed BEFORE the swap: the host drops its handle on every
   * commit failure (see {@link MarketSourceOperations.commitDownload}), so the
   * download must be staged again before it can be used a second time.
   *
   * The CALLER handle stays usable for the whole download window — this flag is
   * a "re-stage first" marker, not a restriction to the commit phase: both
   * `classifyDownload` and `commitDownload` re-stage lazily when they see it,
   * and the first one to do so adopts the new host handle so a classify→commit
   * retry clones exactly once.
   */
  readonly restage?: boolean
}

/** What one staged download was prepared from (enough to stage it again). */
interface DownloadRecipe {
  readonly repositoryRoot: string
  readonly key: PluginMarketKey
  /** Validated `owner/repo` slug. */
  readonly repository: string
  readonly refKind: 'branch' | 'tag' | undefined
  readonly ref: string | null
}

/**
 * Why one download handle cannot be used, as the machine-readable
 * `details.reason` of the failure. Two forms exist on purpose so a consumer can
 * tell "you never prepared this" apart from "your staged checkout was swept":
 * the first needs a fresh review+prepare, the second additionally means any
 * staging directory has already been cleaned up.
 *
 * Every constant is `satisfies`-checked against the shared closed set
 * ({@link MarketDownloadFailureReason} in `src/types.ts`), which turns "the
 * control layer produces exactly what the cross-face document promises" into a
 * compile-time fact instead of a convention. The set is framework-owned and is
 * never widened here: a value the host wants to add is added there first.
 */
export const DOWNLOAD_REASON_UNKNOWN = 'download-unknown' satisfies MarketDownloadFailureReason
export const DOWNLOAD_REASON_EXPIRED = 'download-expired' satisfies MarketDownloadFailureReason
/** A commit failed before the swap: nothing moved and the commit is retryable. */
export const DOWNLOAD_REASON_COMMIT_BEFORE_SWAP = 'commit-before-swap' satisfies MarketDownloadFailureReason
/** A commit failed after the swap with no record for the new checkout. */
export const DOWNLOAD_REASON_REPAIR_NO_RECORD = 'repair:checkout-committed-no-record' satisfies MarketDownloadFailureReason
/** A commit failed after the swap while the previous record is still in place. */
export const DOWNLOAD_REASON_REPAIR_RECORD_STALE = 'repair:checkout-committed-record-stale' satisfies MarketDownloadFailureReason

/**
 * The classification fields one review carries: the predicted tag, the
 * localizable note explaining a missing runnable entry, and the build-required
 * marker of a plugin whose entry is not built yet.
 */
interface ReviewClassification {
  readonly classification: PluginMarketClassification
  readonly note: MarketInstallNote | null
  readonly buildRequired: boolean
}

/**
 * Outcome of one smart-install analysis attempt: the distribution the model
 * answered with (`null` = the model judged the checkout a standard installable
 * plugin), or `null` when no usable analysis was available at all — no engine
 * is configured, or the analysis failed. The two null cases are deliberately
 * distinct: a model answer of "an ordinary plugin" is a `plugin` prediction,
 * while an unavailable analysis degrades to the conservative `other` one.
 */
type CandidateAnalysis =
  | { readonly available: true; readonly distribution: PluginAnalysisDistribution | null }
  | { readonly available: false }

/**
 * Note of a review whose checkout could not be classified by the analyzer. It
 * is intentionally free of Host-authored prose: the consumer renders the copy
 * for `kind` from its own locale dictionary (see {@link MarketInstallNote}).
 */
export const ANALYSIS_UNAVAILABLE_NOTE: MarketInstallNote = { kind: 'analysis-unavailable' }

/**
 * Legacy `entryNote` of one review note: the engine-supplied detail only. A
 * note without detail (the "analysis unavailable" case, whose copy the consumer
 * localizes from `note.kind`) yields `undefined`, so the Host never ships
 * user-facing prose through this field.
 */
function legacyEntryNoteOf(note: MarketInstallNote | null): string | undefined {
  if (note === null) return undefined
  const text = note.text?.trim()
  return text === undefined || text.length === 0 ? undefined : text
}

/**
 * Render the analyzer distribution as the review's legacy `analysis` field
 * (the richer analyzer vocabulary consumers already render). Only a real
 * non-plugin verdict carries it: a plugin that merely needs its build step is
 * part of the classification/note contract instead, and an unavailable
 * analysis has no verdict at all.
 */
function reviewAnalysisOf(analysis: CandidateAnalysis): PluginInstallReviewAnalysis | undefined {
  if (!analysis.available || analysis.distribution === null) return undefined
  const distribution = analysis.distribution
  if (distribution.classification === 'plugin' && !distribution.buildRequired) return undefined
  return {
    installable: false,
    // Preset/tooling fold into the persisted `other` tag; the review keeps the
    // folded label so the UI never renders a kind the tag vocabulary lacks.
    kind: distribution.classification,
    reason: distribution.reason,
  }
}

/** Branch/tag discriminator of one v2 install tuple. */
export type SourceRefKind = 'branch' | 'tag'

/**
 * Normalize the optional wire `refKind`. Absent (null/undefined) selects the
 * legacy-compatible default-branch install; `'branch'`/`'tag'` select the v2
 * per-ref tuple install. Anything else is a caller bug surfaced as
 * `market/bad-request`.
 */
function normalizeRefKind(refKind: string | null | undefined): SourceRefKind | undefined {
  if (refKind === undefined || refKind === null) return undefined
  if (refKind === 'branch' || refKind === 'tag') return refKind
  throw new MarketControlError(
    'market/bad-request',
    `The "refKind" must be "branch", "tag" or omitted (null); got ${JSON.stringify(refKind)}.`,
  )
}

/**
 * The stable key of one install intent: slug legacy or per-ref tuple key. The
 * ref is only read on the v2 branch (legacy keys ignore it); callers already
 * require a non-empty ref name for v2, so the empty guard below is defensive —
 * `pluginKeyForGithubRef` answers `record/key-invalid` if it ever fires.
 */
function deriveInstallKey(slug: string, refKind: SourceRefKind | undefined, ref: string | null): PluginMarketKey {
  return refKind === undefined ? pluginKeyForRepository(slug) : pluginKeyForGithubRef(slug, refKind, ref ?? '')
}

/**
 * A v2 install needs its branch/tag name to derive the tuple key and checkout
 * path; the name rides in the legacy `version` argument (the wire keeps the
 * pre-v2 parameter name). Without one the caller should omit refKind entirely
 * and get the legacy default-branch install instead.
 */
function requireRefName(slug: string, refKind: SourceRefKind, ref: string | null): string {
  if (ref === null || ref.length === 0) {
    throw new MarketControlError(
      'market/bad-request',
      `Installing the ${refKind} of "${slug}" requires its name in "version" (choose a branch/tag from the repository detail); omit refKind to install the default branch the legacy way.`,
    )
  }
  return ref
}

/**
 * Derive the stable loader key of a repository slug for a legacy (no refKind)
 * install: `gh-owner-repo`. Kept for pre-v2 compatibility — old records use
 * exactly this key and a no-refKind install must keep overwriting them.
 */
export function pluginKeyForRepository(repository: string): PluginMarketKey {
  const normalized = parseRepositorySlug(repository)
  const slash = normalized.indexOf('/')
  const owner = normalized.slice(0, slash)
  const repo = normalized.slice(slash + 1)
  return parsePluginKey(`gh-${owner}-${repo}`)
}

/**
 * Shape check for the stable `github/not-found` code. Structural (not
 * instanceof) so a not-found thrown by another copy of the error class is
 * still recognized; the code itself belongs to the shared wire vocabulary.
 */
function isGithubNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'github/not-found'
}

/** Stable wire code of any thrown value (structural, not instanceof-bound). */
function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

/**
 * Machine-readable details of any thrown value, read structurally so a
 * `MarketError` raised by another copy of the host package (its `details` field
 * is added by the host, not by this module) is still understood.
 */
function detailsOf(error: unknown): Readonly<Record<string, unknown>> {
  const details = (error as { details?: unknown } | null)?.details
  return typeof details === 'object' && details !== null ? details as Record<string, unknown> : {}
}

/**
 * The host's swap fact of one commit failure: `true` only when the host reports
 * that the rename already happened (`details.swapCompleted`), `false` when it
 * reports it did not, and `undefined` for failures that carry no fact at all
 * (e.g. an input-validation refusal before the swap window).
 */
function swapFactOf(error: unknown): boolean | undefined {
  const value = detailsOf(error).swapCompleted
  return typeof value === 'boolean' ? value : undefined
}

/** Checkout directory the host reported on a commit failure, when present. */
function swapCheckoutDirOf(error: unknown): string | undefined {
  const value = detailsOf(error).checkoutDir
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The host's `previousRemoved` sub-window fact of a commit failure: `true` only
 * when the host had already deleted the previous checkout to make room before
 * failing (so that checkout is gone), `false` when it reports it did not, and
 * `undefined` for failures that carry no fact at all.
 *
 * Only meaningful before the swap: with `swapCompleted === true` the new
 * checkout is in place and the flag says nothing.
 */
function previousRemovedOf(error: unknown): boolean | undefined {
  const value = detailsOf(error).previousRemoved
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Map any thrown value onto a code this module may raise itself. Anything
 * outside the wire vocabulary becomes `install/io` (the download/commit family
 * code) so the channel never invents an unknown code.
 */
function wireCodeOf(error: unknown): MarketWireErrorCode {
  const code = errorCodeOf(error)
  return code !== undefined && WIRE_CODES.has(code) ? code as MarketWireErrorCode : 'install/io'
}

/** Every code of the shared wire vocabulary (see src/types.ts). */
const WIRE_CODES = new Set<string>([
  'config/invalid', 'repository/not-exist', 'repository/not-directory', 'repository/not-writable',
  'repository/io', 'record/key-invalid', 'record/exists', 'record/not-found', 'record/corrupt',
  'record/io', 'record/invalid', 'harness/resolve-failed', 'harness/link-conflict', 'harness/io',
  'github/auth', 'github/rate-limit', 'github/network', 'github/not-found', 'github/bad-response',
  'github/bad-request', 'install/dir-exists', 'install/dir-in-use', 'install/entry-missing',
  'install/package-invalid', 'install/git-failed', 'install/deps-failed', 'install/io',
  'gate/consent-required', 'market/llm-unconfigured', 'market/llm-failed', 'market/llm-bad-output',
  'market/io', 'market/unsupported-skills', 'market/unsupported-preset', 'market/unsupported-build',
  'market/unsupported-other', 'market/idle', 'market/not-found', 'market/protected',
  'market/not-loadable', 'market/confirm-required', 'market/confirm-invalid', 'market/confirm-expired',
  'market/load-failed', 'market/bad-request',
])

/**
 * Normalize one thrown failure into the wire detail shape: the shared
 * `MarketRemoteErrorDetails` only carries `key` / `path` / `reason`, so host
 * details (`swapCompleted`, `previousRemoved`, `checkoutDir`, `token`, …) are
 * mapped onto those fields rather than forwarded as unknown properties — the
 * wire contract stays the single source of truth for what a consumer can read. A
 * value of the wrong type is DROPPED, never coerced or forwarded as-is: a
 * non-string `key` from a foreign failure must not reach a consumer that reads
 * `key` as a string.
 *
 * The swap facts deliberately have no wire slot: `swapCompleted` and
 * `previousRemoved` are only ever expressed through the failure message and the
 * `reason` vocabulary, and the host's `checkoutDir` is what `path` receives.
 */
export function wireDetailsOf(error: unknown): MarketRemoteErrorDetails {
  const details = detailsOf(error)
  const detailsKey = typeof details.key === 'string' ? details.key : undefined
  const detailsPath = typeof details.path === 'string'
    ? details.path
    : swapCheckoutDirOf(error)
  return {
    ...(detailsKey === undefined ? {} : { key: detailsKey }),
    ...(detailsPath === undefined ? {} : { path: detailsPath }),
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
  }
}

/**
 * Normalize the classification a caller picked for the commit phase. Only the
 * persisted tag vocabulary is accepted; anything else is a caller bug surfaced
 * as the stable `market/bad-request` (zero side effect on the staged download —
 * the handle stays usable so the UI can retry with a valid label).
 */
export function requireClassification(value: unknown): PluginMarketClassification {
  if (isPluginMarketClassification(value)) return value
  throw new MarketControlError(
    'market/bad-request',
    `The "classification" must be one of "plugin", "skills" or "other"; got ${JSON.stringify(value)}.`,
  )
}

/** Default download-stage TTL: ten minutes from the successful prepare. */
export const DEFAULT_DOWNLOAD_TTL_MS = 10 * 60_000

/** Upper bound of the spent-handle bookkeeping (reason text stays accurate). */
const EXPIRED_HANDLE_LIMIT = 64

/**
 * The market's source operations. Never throws for a healthy idle market with
 * a message a caller can show; all failures carry stable wire codes.
 */
export class MarketSourceOperations {
  /**
   * Review confirmations, keyed by the derived plugin key: "may this review
   * start a download?" (short window, single use).
   */
  private readonly reviews = new Map<PluginMarketKey, ReviewEntry>()
  /**
   * In-flight staged downloads, keyed by their handle token: "may this staged
   * checkout still be classified/committed?" (own, longer window). Keyed by the
   * HANDLE, not by the plugin key, so a new review of the same plugin can never
   * clobber a download already in progress.
   */
  private readonly downloads = new Map<DownloadHandle, DownloadEntry>()
  /**
   * Handles whose staged download was swept or consumed. Kept only to explain a
   * later call on that handle (`details.reason` distinguishes "expired" from
   * "never prepared"); bounded by {@link EXPIRED_HANDLE_LIMIT}.
   */
  private readonly spentHandles = new Set<DownloadHandle>()

  constructor(private readonly deps: MarketSourceDeps) {}

  /**
   * Drop the entries whose own deadline has passed, cancelling the staging of
   * any download that is dropped. Called at the start of every review.
   *
   * The two registries have independent deadlines — that is the point of the
   * split: a review expires after its confirmation window, while a download
   * expires after {@link MarketSourceDeps.downloadTtlMs} counted from its
   * successful prepare. The review window it already spent has no say over a
   * download in progress.
   */
  private async sweepStale(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))().getTime()
    for (const [key, review] of [...this.reviews]) {
      if (now >= review.expiresAt) this.reviews.delete(key)
    }
    for (const [caller, download] of [...this.downloads]) {
      if (now < download.expiresAt) continue
      this.retire(caller, download.token)
      await this.cancelStaging(download.key, download.token)
    }
    this.forgetSpentHandles()
  }

  /** Best-effort staging cleanup of one dropped download. */
  private async cancelStaging(key: PluginMarketKey, token: DownloadHandle): Promise<void> {
    const repository = this.deps.repository()
    if (repository === null) return
    try {
      await this.deps.installer(repository).cancel(token)
    } catch (error) {
      this.deps.logger?.warn(
        `market download: could not clean up the abandoned staging of "${key}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Keep the spent-handle bookkeeping from growing without bound. */
  private forgetSpentHandles(): void {
    if (this.spentHandles.size <= EXPIRED_HANDLE_LIMIT) return
    const excess = this.spentHandles.size - EXPIRED_HANDLE_LIMIT
    let dropped = 0
    for (const token of this.spentHandles) {
      this.spentHandles.delete(token)
      if (++dropped >= excess) break
    }
  }

  /**
   * The in-flight download of one plugin key, when there is one.
   *
   * The returned `caller` is the map key (the token the caller holds); the
   * entry's own `token` is the host handle live right now, which differs from it
   * after a re-stage.
   */
  private downloadOf(key: PluginMarketKey): { readonly caller: DownloadHandle; readonly entry: DownloadEntry } | undefined {
    for (const [caller, entry] of this.downloads) {
      if (entry.key === key) return { caller, entry }
    }
    return undefined
  }


  /**
   * GitHub topic search. Requires a configured repository (market not idle).
   * `page` is 1-based and defaults to 1; range clamping of oversized pages is
   * the host GitHubMarket's responsibility, so this layer forwards it as-is.
   */
  async search(
    options: { readonly keywords?: string; readonly perPage?: number; readonly page?: number } = {},
  ): Promise<GitHubSearchPage> {
    this.requireRepository()
    return this.deps.searchEngine.search({
      ...(options.keywords === undefined ? {} : { keywords: options.keywords }),
      ...(options.perPage === undefined ? {} : { perPage: options.perPage }),
      page: options.page ?? 1,
    })
  }

  /**
   * Aggregated detail of one remote GitHub repository (metadata, branches,
   * tags and README), fetched in parallel. Requires a configured repository
   * (market not idle), like the other source operations. A repository without
   * a README yields `readme: null` — the GitHub 404 for the endpoint is
   * tolerated whether the engine mapped it to null or threw
   * `github/not-found`; any other failure of the four queries fails the whole
   * call with its stable `github/*` code.
   */
  async repositoryDetail(slugRaw: string): Promise<RepositoryDetail> {
    this.requireRepository()
    const slug = parseRepositorySlug(slugRaw)
    const detail = this.deps.detailEngine
    const [meta, branches, tags, readme] = await Promise.all([
      detail.repositoryMeta(slug),
      detail.branches(slug),
      detail.tags(slug),
      detail.readme(slug).catch((error: unknown) => {
        if (isGithubNotFound(error)) return null
        throw error
      }),
    ])
    return {
      repository: slug,
      name: meta.name,
      description: meta.description,
      stars: meta.stars,
      updatedAt: meta.updatedAt,
      url: meta.url,
      cloneUrl: meta.cloneUrl,
      defaultBranch: meta.defaultBranch,
      branches: [...branches],
      tags: [...tags],
      readme,
    }
  }

  /**
   * Review one repository (or one ref of it) and mint the single-use install
   * confirmation. With `refKind` omitted the review targets the
   * legacy-compatible default-branch install of the slug (its key stays
   * `gh-owner-repo`, so pre-v2 records without a ref kind keep matching);
   * with `refKind: 'branch' | 'tag'` it targets that specific ref, keyed by
   * the `(owner, repo, ref-kind, ref)` tuple — a branch and a tag of the same
   * name review as two independent plugins.
   *
   * Classification (never a refusal): the review carries the tag the install is
   * PREDICTED to file — `plugin` for a standard npm checkout whose remote
   * manifest was readable, the analyzer's `skills`/`other` verdict for an
   * unconventional candidate (no readable package.json on the probed
   * branches), and the conservative `other` when no analysis engine is wired or
   * the analysis failed. The prediction is a hint: the download inspects the
   * real checkout and files a checkout with a runnable entry as `plugin`
   * whatever the review said, and the authoritative tags come back on the
   * install outcome. `note` is the structured, localizable explanation of a
   * missing runnable entry (consumers render its `kind` through their own
   * dictionary) and `buildRequired` marks the plugin that needs its build step
   * first (test-only seam, see `MarketSourceDeps.analysisEntryProbe`); both let
   * the UI warn while still offering the download. The review mints its
   * confirmation token in every case.
   */
  async previewInstall(
    repositoryRaw: string,
    refKind: string | null = null,
    version: string | null = null,
  ): Promise<PluginInstallReview> {
    const repository = this.requireRepository()
    await this.sweepStale()
    const slug = parseRepositorySlug(repositoryRaw)
    const kind = normalizeRefKind(refKind)
    const ref = kind === undefined ? version : requireRefName(slug, kind, version)
    const key = deriveInstallKey(slug, kind, ref)
    const existing = await repository.records.get(key)
    if (existing !== null) this.assertOverwriteAllowed(existing, repository)

    const preview = await this.deps.previewEngine.preview(slug)
    const analysis: CandidateAnalysis = MarketSourceOperations.isUnconventionalPreview(preview)
      ? await this.analyzeCandidate(slug, preview)
      : { available: true, distribution: null }
    const review = MarketSourceOperations.reviewClassificationFrom(preview, analysis)
    const analysisVerdict = reviewAnalysisOf(analysis)
    const token = randomBytes(16).toString('hex')
    const now = (this.deps.now ?? (() => new Date()))()
    const ttl = this.deps.confirmTtlMs ?? REMOVE_CONFIRM_TTL_MS
    this.reviews.set(key, {
      token,
      expiresAt: now.getTime() + ttl,
      version: ref,
      classification: review.classification,
      note: review.note,
      // The recipe is known at review time; keeping it here is what lets a
      // download be staged (and a failed commit re-staged) later.
      recipe: {
        repositoryRoot: repository.root,
        key,
        repository: slug,
        refKind: kind,
        ref: ref ?? null,
      },
    })
    const entryNote = legacyEntryNoteOf(review.note)
    return {
      repository: slug,
      key,
      preview,
      exists: existing !== null,
      overwrite: existing !== null,
      existing,
      confirmToken: token,
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      classification: review.classification,
      ...(review.buildRequired ? { buildRequired: true } : {}),
      ...(entryNote === undefined ? {} : { entryNote }),
      ...(review.note === null ? {} : { note: review.note }),
      ...(kind === undefined ? {} : { refKind: kind }),
      ...(analysisVerdict === undefined ? {} : { analysis: analysisVerdict }),
    }
  }

  /**
   * Phase 1 of the download channel — consume the single-use preview
   * confirmation and clone the checkout into the host's private staging area.
   *
   * Nothing is filed and nothing is enabled here: the review token is consumed
   * (single use), the download handle is registered in memory for the later
   * phases, and the caller receives the facts the UI needs to show "cloning
   * sources" finished.
   */
  async prepareDownload(
    repositoryRaw: string,
    confirmToken: string,
    refKind: string | null = null,
    version: string | null = null,
  ): Promise<DownloadPreparation> {
    const repository = this.requireRepository()
    const slug = parseRepositorySlug(repositoryRaw)
    const kind = normalizeRefKind(refKind)
    const ref = kind === undefined ? version : requireRefName(slug, kind, version)
    const key = deriveInstallKey(slug, kind, ref)
    const review = this.reviews.get(key)
    if (review === undefined) {
      throw new MarketControlError(
        'market/confirm-required',
        `Downloading "${slug}" needs a previewInstall() confirmation for this ref first.`,
        { key },
      )
    }
    if (review.token !== confirmToken) {
      throw new MarketControlError(
        'market/confirm-invalid',
        `The download confirmation token for "${slug}" does not match.`,
        { key },
      )
    }
    const now = (this.deps.now ?? (() => new Date()))()
    if (now.getTime() >= review.expiresAt) {
      this.reviews.delete(key)
      throw new MarketControlError(
        'market/confirm-expired',
        `The confirmation for "${slug}" expired; review the plugin again.`,
        { key },
      )
    }
    // The review already re-checked protection; the target may still have been
    // claimed since, which the host re-checks while preparing.
    const existing = await repository.records.get(key)
    if (existing !== null) this.assertOverwriteAllowed(existing, repository)

    // Downloading this plugin again supersedes an older in-flight download of
    // the same key: its staged checkout is garbage by definition now.
    const previous = this.downloadOf(key)
    if (previous !== undefined) {
      this.retire(previous.caller, previous.entry.token)
      this.deps.logger?.warn(
        `market download: "${key}" is downloaded again; the previous staged checkout was discarded.`,
      )
      await this.cancelStaging(key, previous.entry.token)
    }

    const installer = this.deps.installer(repository)
    const prepared = await installer.prepare({
      repositoryRoot: repository.root,
      key,
      repository: slug,
      ...(kind === undefined ? {} : { refKind: kind }),
      version: ref ?? review.version ?? null,
    })
    // Single use: the confirmation is spent now that a download exists for it.
    // The download then gets its OWN deadline, counted from this successful
    // prepare — the (now spent) review window no longer governs it.
    const downloadTtl = this.deps.downloadTtlMs ?? DEFAULT_DOWNLOAD_TTL_MS
    this.reviews.delete(key)
    this.downloads.set(prepared.token, {
      token: prepared.token,
      key,
      expiresAt: now.getTime() + downloadTtl,
      recipe: {
        ...review.recipe,
        ref: prepared.ref ?? ref ?? review.version ?? null,
      },
    })
    return {
      token: prepared.token,
      key,
      repository: slug,
      ...(prepared.refKind === undefined ? {} : { refKind: prepared.refKind }),
      ref: prepared.ref,
      localDirName: prepared.localDirName,
      commit: prepared.commit,
      startedAt: prepared.startedAt,
      state: prepared.state,
      overwrite: existing !== null,
    }
  }

  /**
   * Phase 2 of the download channel — classify the staged checkout.
   *
   * Never rejects for a model problem: the host classifier degrades an
   * unavailable or failing model to `outcome: 'unclassified' | 'failed'` with
   * `classification: 'other'` and a stable `errorCode`, so the UI can show the
   * reason and let the user either retry, correct the tag manually
   * (`setClassification`) or commit the conservative label. The only failure
   * this method raises is an unknown/expired handle (`record/not-found`, with
   * `details.reason` telling the two apart).
   *
   * A handle left retryable by a pre-swap commit failure is classified just as
   * well: the entry is re-staged from its recipe first (the host dropped the old
   * handle when the commit failed) and the replacement is adopted, so the
   * follow-up commit needs no second clone. There is deliberately no
   * "commit-only" phase restriction — the caller handle stays usable for every
   * phase of the download for its whole window.
   */
  async classifyDownload(token: string): Promise<DownloadClassification> {
    const repository = this.requireRepository()
    const entry = await this.requireDownload(token)
    const installer = this.deps.installer(repository)
    return await installer.classify(await this.ensureStaged(token, entry, installer))
  }

  /**
   * Phase 3 of the download channel — swap the staged checkout into place and
   * file the record under the classification the caller chose.
   *
   * Failure routing follows the host's authoritative swap fact
   * (`details.swapCompleted`, attached to every commit failure):
   *
   * - **before the swap** (false/absent): the checkout never moved. The host
   *   dropped its own handle, so this call keeps the handle **retryable** on the
   *   control side and records the recipe: the next `classifyDownload` or
   *   `commitDownload` with the same token re-stages from that recipe first. The
   *   wire failure carries `details.reason = 'commit-before-swap'`, and its
   *   message distinguishes the host's `details.previousRemoved` sub-window — the
   *   previous checkout and record are untouched (plain retry) versus the
   *   previous checkout had ALREADY been deleted while its record still points at
   *   it (the data is gone; retrying re-stages and re-files, or repair by hand,
   *   and the missing directory travels as the wire `path`). The
   *   `previousRemoved` flag itself never reaches the wire.
   * - **after the swap** (true): the new checkout is already in place and only
   *   the record write failed, so this is a repair situation, not a retry. The
   *   two forms are distinguished for the user:
   *   - no record existed before the commit → `'repair:checkout-committed-no-record'`
   *     — the fresh checkout must be removed by hand;
   *   - the previous record is still in place → `'repair:checkout-committed-record-stale'`
   *     — the download can simply be run again (idempotent overwrite).
   *   Both carry the host's `checkoutDir` as the wire `path`.
   *
   * A handle is consumable ONCE: a successful commit retires both the handle it
   * committed with and, on a retried commit, the original token that was
   * re-staged — so repeating the call can never silently clone the repository a
   * second time.
   */
  async commitDownload(token: string, classification: string): Promise<DownloadCommit> {
    const repository = this.requireRepository()
    const entry = await this.requireDownload(token)
    const key = entry.key
    const label = requireClassification(classification)
    const before = await repository.records.get(key)
    const installer = this.deps.installer(repository)

    // A retry after a pre-swap failure: the host forgot the old handle, so the
    // checkout is staged again from the recipe before the commit is attempted.
    const handle = await this.ensureStaged(token, entry, installer)

    try {
      const committed = await installer.commit({ token: handle, classification: label })
      this.retire(token, handle)
      await this.deps.syncRecord(committed.record)
      return {
        key,
        overwritten: committed.overwritten,
        record: committed.record,
        checkoutDir: committed.checkoutDir,
        classification: committed.classification,
        entry: committed.entry,
        dependenciesInstalled: committed.dependenciesInstalled,
        note: committed.note,
      }
    } catch (error) {
      if (swapFactOf(error) === true) {
        // The checkout is in place and only the record write failed: this is a
        // repair, not a retry.
        this.retire(token, handle)
        throw this.repairFailure(error, key, before)
      }
      // Pre-swap failure: nothing moved. Keep the download registered (marked
      // for a re-stage) so the same token can retry.
      this.markRestage(token)
      throw this.preSwapFailure(error, key)
    }
  }

  /**
   * Cancel a staged download (the "取消并清理暂存" action): the host removes the
   * staging directory — zero residue — and forgets the handle, and the download
   * entry is dropped. Idempotent: an unknown, already-cancelled or committed
   * handle resolves to `false` without touching the filesystem.
   *
   * Cancelling targets the host handle that is live right now, so a download
   * that was re-staged after a pre-swap failure (or already re-staged by a
   * retried classify) is cleaned up correctly; the caller keeps using the token
   * it was given.
   */
  async cancelDownload(token: string): Promise<boolean> {
    const repository = this.deps.repository()
    const entry = this.downloads.get(token)
    if (entry === undefined) return false
    const cancelled = repository === null
      ? false
      : await this.deps.installer(repository).cancel(entry.token)
    if (cancelled) this.retire(token, entry.token)
    return cancelled
  }

  private requireRepository(): MarketRepository {
    const repository = this.deps.repository()
    if (repository === null) {
      throw new MarketControlError(
        'market/idle',
        'The plugin market is idle: configure Config.repositoryPath on plugin-market-host to search, inspect or install plugins.',
      )
    }
    return repository
  }

  /**
   * Resolve a download handle or fail with the stable not-found code.
   *
   * A handle whose own deadline has passed is expired here and now (its staging
   * is cancelled and it is remembered as spent), so the failure reason is
   * accurate even when no review sweep happened in between.
   *
   * Both handles are retired and the CURRENT host handle is the one cancelled:
   * after a re-stage the caller token names no live staging at all, so
   * cancelling it would leave the checkout the host actually holds behind
   * (mirrors {@link sweepStale}).
   */
  private async requireDownload(token: string): Promise<DownloadEntry> {
    const entry = this.downloads.get(token)
    if (entry === undefined) throw this.handleLost(token)
    const now = (this.deps.now ?? (() => new Date()))().getTime()
    if (now >= entry.expiresAt) {
      this.retire(token, entry.token)
      await this.cancelStaging(entry.key, entry.token)
      throw this.handleLost(token)
    }
    return entry
  }

  /**
   * The stable failure of a handle that cannot be used. `details.reason`
   * distinguishes the two cases a consumer must treat differently:
   * `download-expired` (the staged checkout was swept, so any staging is gone)
   * versus `download-unknown` (never prepared in this process — a stale handle
   * from a previous run, or a client-side mistake).
   */
  private handleLost(token: string): MarketControlError {
    const expired = this.spentHandles.has(token)
    return new MarketControlError(
      'record/not-found',
      expired
        ? 'This download handle is no longer usable: its staged checkout was cleaned up. Start the download again (handles are process-local and never survive a restart).'
        : 'This download handle is unknown in this process; start the download again (handles are never persisted and never survive a restart).',
      { path: token, reason: expired ? DOWNLOAD_REASON_EXPIRED : DOWNLOAD_REASON_UNKNOWN },
    )
  }

  /**
   * The host staging handle to use for the next phase, re-staging the download
   * first when the host dropped its handle (a pre-swap commit failure — see
   * {@link commitDownload}).
   *
   * The replacement is adopted by the entry, so the caller keeps using the token
   * it was given and a classify→commit retry clones the repository exactly once.
   */
  private async ensureStaged(
    caller: DownloadHandle,
    entry: DownloadEntry,
    installer: InstallerPort,
  ): Promise<DownloadHandle> {
    if (entry.restage !== true) return entry.token
    const staged = await installer.prepare({
      repositoryRoot: entry.recipe.repositoryRoot,
      key: entry.recipe.key,
      repository: entry.recipe.repository,
      ...(entry.recipe.refKind === undefined ? {} : { refKind: entry.recipe.refKind }),
      version: entry.recipe.ref,
    })
    this.downloads.set(caller, {
      token: staged.token,
      key: entry.key,
      expiresAt: entry.expiresAt,
      recipe: entry.recipe,
    })
    this.deps.logger?.warn(
      `market download: re-staged "${entry.key}" after a pre-swap commit failure; the download handle stays usable.`,
    )
    return staged.token
  }

  /**
   * Drop one download entry for good, remembering BOTH handles as consumed: the
   * caller handle (so a later call on it reports `download-expired` instead of
   * silently re-staging) and the host handle that was live (a re-stage replaces
   * `entry.token`, so the two differ after a retry).
   */
  private retire(caller: DownloadHandle, hostToken: DownloadHandle): void {
    this.downloads.delete(caller)
    this.spentHandles.add(caller)
    if (hostToken !== caller) this.spentHandles.add(hostToken)
  }

  /** Mark one download retryable: the next host-bound phase re-stages from its recipe. */
  private markRestage(caller: DownloadHandle): void {
    const entry = this.downloads.get(caller)
    if (entry === undefined) return
    this.downloads.set(caller, { ...entry, restage: true })
  }

  /**
   * Wrap a commit failure that happened BEFORE the swap: nothing moved, the host
   * already cleaned its staging and dropped its handle, and the control side kept
   * the recipe so the same token can be retried (with either phase — the next
   * host-bound call re-stages first).
   *
   * The host's `details.previousRemoved` splits this window in two, and the two
   * need different words: only the second one lost data. The fact itself stays
   * off the wire (see {@link wireDetailsOf}) — the message is where it surfaces.
   */
  private preSwapFailure(error: unknown, key: PluginMarketKey): MarketControlError {
    const lostPrevious = previousRemovedOf(error) === true
    const checkoutDir = swapCheckoutDirOf(error)
    const guidance = lostPrevious
      ? `Nothing was swapped in, and the previous checkout had ALREADY been deleted to make room, so that checkout is now missing while its record still points at it${checkoutDir === undefined ? '' : ` (${checkoutDir})`}. Running the download again with the same handle re-stages it and overwrites the record; otherwise the repository has to be repaired by hand.`
      : 'Nothing was swapped in: the staged checkout was cleaned up and the previous checkout and record (if any) are unchanged. Retry the commit with the same download handle.'
    return new MarketControlError(
      errorCodeOf(error) === 'install/io' ? 'install/io' : wireCodeOf(error),
      `${error instanceof Error ? error.message : String(error)} ${guidance}`,
      // `path` is only attached when something actually went missing: it names
      // the checkout directory that no longer exists, which is what the
      // operator has to look at. In the harmless sub-window there is nothing to
      // point at.
      {
        key,
        reason: DOWNLOAD_REASON_COMMIT_BEFORE_SWAP,
        ...(lostPrevious && checkoutDir !== undefined ? { path: checkoutDir } : {}),
      },
      { cause: error },
    )
  }

  /**
   * Wrap a commit failure that happened AFTER the swap: the new checkout is in
   * place and only the record write failed. Two forms are distinguished for the
   * operator — no record at all (the fresh checkout must be removed by hand)
   * versus the previous record still in place (the download can simply be run
   * again, it is an idempotent overwrite).
   */
  private repairFailure(error: unknown, key: PluginMarketKey, before: PluginMarketRecord | null): MarketControlError {
    const checkoutDir = swapCheckoutDirOf(error)
    const noRecord = before === null
    const reason = noRecord ? DOWNLOAD_REASON_REPAIR_NO_RECORD : DOWNLOAD_REASON_REPAIR_RECORD_STALE
    const guidance = noRecord
      ? `The checkout is in place but no record was written for it, so it must be removed by hand${checkoutDir === undefined ? '' : ` (${checkoutDir})`} before the download can be retried cleanly.`
      : 'The new checkout is in place while the previous record still describes the old one; run the download again (it is an idempotent overwrite) to bring the record back in sync.'
    this.deps.logger?.error(
      `market download: "${key}" was swapped into place but its record could not be written (${reason}) — ${guidance}`,
    )
    return new MarketControlError(
      'install/io',
      `${error instanceof Error ? error.message : String(error)} ${guidance}`,
      { key, reason, ...(checkoutDir === undefined ? {} : { path: checkoutDir }) },
      { cause: error },
    )
  }

  /**
   * Whether a preview outcome marks its candidate as unconventional — the
   * checkout has no readable package.json on the probed branches (missing or
   * invalid), so no standard npm plugin entry can be resolved remotely and the
   * checkout is classified by the analyzer instead (or filed as `other` when no
   * analysis is available). Transport failures (network / rate-limit / auth)
   * are not unconventional: the manifest may simply be temporarily unreadable
   * and the review keeps the degraded-but-installable semantics.
   */
  private static isUnconventionalPreview(preview: PluginPreviewOutcome): boolean {
    return preview.status === 'degraded'
      && (preview.code === 'github/not-found' || preview.code === 'github/bad-response')
  }

  /**
   * Map the preview (plus the analyzer outcome, when one ran) onto the
   * review's classification fields. A preview that read the remote manifest
   * normally (`ready`) predicts a loadable `plugin`; an unconventional preview
   * (see {@link isUnconventionalPreview}) is predicted from the analyzer — an
   * available answer decides, a model answer of "an ordinary plugin" predicts
   * `plugin` — and falls back to the conservative `other` tag with
   * {@link ANALYSIS_UNAVAILABLE_NOTE} when no analysis was available at all.
   * Nothing here refuses: everything is surfaced as classification + note, and
   * the entry probe of the real download stays authoritative.
   */
  private static reviewClassificationFrom(
    preview: PluginPreviewOutcome,
    analysis: CandidateAnalysis,
  ): ReviewClassification {
    if (!MarketSourceOperations.isUnconventionalPreview(preview)) {
      return { classification: 'plugin', note: null, buildRequired: false }
    }
    const distribution = analysis.available ? analysis.distribution : null
    if (distribution === null) {
      if (analysis.available) {
        // The model answered "a standard plugin": no classification of its own.
        return { classification: 'plugin', note: null, buildRequired: false }
      }
      return { classification: 'other', note: ANALYSIS_UNAVAILABLE_NOTE, buildRequired: false }
    }
    if (distribution.classification === 'plugin' && distribution.entry !== null) {
      return { classification: 'plugin', note: null, buildRequired: false }
    }
    // A `plugin` judgement without a runnable entry (a checkout that needs its
    // build step first) folds into `other`, exactly as the record store does.
    //
    // `note.entry` semantics (contract with the UI): for `kind: 'entry-missing'`
    // it carries the EXPECTED entry path — the checkout-relative file the
    // analyzer named as the entry the checkout should produce (its
    // `entryHint`), i.e. what a build step would generate. It is the only
    // source of that path on the wire, so a consumer that renders an
    // "expected entry" hint reads it from here; it stays absent when the
    // analyzer named no entry (the field is never invented locally, because the
    // conventional `index.js` fallback is not what the checkout declares).
    return {
      classification: distribution.buildRequired ? 'other' : distribution.classification,
      note: {
        kind: distribution.buildRequired ? 'entry-missing' : 'classified',
        text: distribution.reason,
        ...(distribution.entryHint === null ? {} : { entry: distribution.entryHint }),
      },
      buildRequired: distribution.buildRequired,
    }
  }

  /**
   * Run the smart-install analysis of an unconventional candidate and report
   * whether one was available plus its distribution (see
   * {@link CandidateAnalysis}).
   *
   * Failure semantics (nothing blocks the review): a missing analysis engine
   * (the market Config configured no llm endpoint) and every analyzer failure
   * — unconfigured endpoint, LLM transport/timeout jitter, unparsable output,
   * an I/O failure while probing the entry, engine bugs — answer
   * `{ available: false }`, so the review falls back to the conservative
   * `other` classification with {@link ANALYSIS_UNAVAILABLE_NOTE}. The failure
   * is logged for operators and the candidate stays installable (filed as a
   * non-plugin checkout without a loader row).
   */
  private async analyzeCandidate(
    slug: string,
    preview: PluginPreviewOutcome,
  ): Promise<CandidateAnalysis> {
    const engine = this.deps.analysis
    if (engine === undefined) {
      this.deps.logger?.warn(
        `Smart-install analysis unavailable for "${slug}": no analyzer is configured (set Config.llm.provider and Config.llm.model on plugin-market-host). The checkout will be filed as a non-plugin.`,
      )
      return { available: false }
    }
    const probe = this.deps.analysisEntryProbe
    try {
      return {
        available: true,
        distribution: await engine.analyze({
          repository: slug,
          preview,
          ...(probe === undefined ? {} : { hasFile: (entry: string) => probe(slug, entry) }),
        }),
      }
    } catch (error) {
      this.deps.logger?.warn(
        `Smart-install analysis of "${slug}" failed (${errorCodeOf(error) ?? 'unexpected'}): ${error instanceof Error ? error.message : String(error)}. The checkout will be filed as a non-plugin.`,
      )
      return { available: false }
    }
  }

  /** Overwriting or deleting a protected/self entry is never allowed. */
  private assertOverwriteAllowed(record: PluginMarketRecord, repository: MarketRepository): void {
    const protectedKey = this.deps.protection.isProtectedKey(record.key)
    const selfModule = this.deps.protection.isSelfModule(entryModuleName(repository.root, record))
    if (protectedKey || selfModule) {
      throw new MarketControlError(
        'market/protected',
        `"${record.key}" is a protected plugin-market entry and cannot be overwritten.`,
        { key: record.key },
      )
    }
  }
}