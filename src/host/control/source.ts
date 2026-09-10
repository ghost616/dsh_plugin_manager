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
  readonly state: 'prepared' | 'classified' | 'committed'
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
  readonly outcome: 'classified' | 'unclassified' | 'failed'
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

/**
 * Opaque download handle as it travels the control channel. The host brands its
 * own `DownloadToken`; the control layer keeps the wire/user-facing view a plain
 * string (the channel is JSON) and hands the value back verbatim.
 */
export type DownloadHandle = string

/**
 * Channel answer of the prepare phase: what was cloned, under which handle, and
 * the facts the UI shows for "cloning sources".
 *
 * `token` is the DOWNLOAD handle (process-local, in-memory, never persisted) —
 * the single-use preview confirmation was consumed by this call.
 */
export interface DownloadPreparation {
  readonly token: DownloadHandle
  readonly key: PluginMarketKey
  readonly repository: string
  readonly refKind?: 'branch' | 'tag'
  readonly ref: string | null
  readonly localDirName: string
  readonly commit: string | null
  readonly startedAt: string
  readonly state: 'prepared' | 'classified' | 'committed'
  /** Whether a record already exists for this key (the commit will overwrite). */
  readonly overwrite: boolean
}

/** Channel answer of the classification phase (never a thrown model failure). */
export interface DownloadClassification {
  readonly outcome: 'classified' | 'unclassified' | 'failed'
  readonly classification: PluginMarketClassification
  /** Engine rationale; the UI renders its own copy for `outcome`/`errorCode`. */
  readonly reason: string
  readonly unclassified: boolean
  readonly entryPresent: boolean | null
  readonly entryHint: string | null
  readonly errorCode?: string
}

/** Channel answer of the commit phase. */
export interface DownloadCommit {
  readonly key: PluginMarketKey
  readonly overwritten: boolean
  readonly record: PluginMarketRecord
  readonly checkoutDir: string
  readonly classification: PluginMarketClassification
  readonly entry: string | null
  /** Always false: the download path never installs dependencies. */
  readonly dependenciesInstalled: boolean
  readonly note: string | null
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
 * One reviewed-and-possibly-staged download, keyed by the derived install key.
 *
 * It carries two independent handles, both process-local and in memory only:
 * - `token` — the single-use PREVIEW confirmation minted by
 *   {@link MarketSourceOperations.previewInstall}; it expires after
 *   `reviewExpiresAt` and is consumed by `prepareDownload`;
 * - `downloadToken` — the host staging handle minted by the prepare phase; it
 *   is valid until the download is committed or cancelled (or until the
 *   installer instance goes away — it is never persisted, never replayed after
 *   a restart, and never shared across requests).
 *
 * Written by `prepareDownload` (the field is replaced atomically there), read by
 * `classifyDownload` / `commitDownload` / `cancelDownload`.
 */
interface PendingDownload {
  /** Single-use preview confirmation presented to `prepareDownload`. */
  readonly token: string
  /** Expiry of the preview confirmation (the review's own TTL). */
  readonly reviewExpiresAt: number
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
  /** Host staging handle; present only between prepare and commit/cancel. */
  readonly downloadToken?: DownloadHandle
}

/** Why one download handle is no longer usable. */
const DOWNLOAD_HANDLE_LOST =
  'This download handle is unknown or has expired; start the download again (handles are process-local and never survive a restart).'

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

/**
 * The market's source operations. Never throws for a healthy idle market with
 * a message a caller can show; all failures carry stable wire codes.
 */
export class MarketSourceOperations {
  private readonly pending = new Map<PluginMarketKey, PendingDownload>()

  constructor(private readonly deps: MarketSourceDeps) {}

  /**
   * Drop pending entries that can no longer be used, and cancel the staging of
   * any download they were holding. Called at the start of a review:
   * - a review that was consumed by `prepareDownload` but never committed or
   *   cancelled is swept once its (spent) confirmation window has passed, so
   *   abandoned staging directories cannot pile up;
   * - an unconsumed review is dropped once its confirmation expires.
   */
  private async sweepStalePending(): Promise<void> {
    if (this.pending.size === 0) return
    const now = (this.deps.now ?? (() => new Date()))().getTime()
    const repository = this.deps.repository()
    for (const [key, entry] of [...this.pending]) {
      if (now < entry.reviewExpiresAt) continue
      this.pending.delete(key)
      if (entry.downloadToken === undefined || repository === null) continue
      try {
        await this.deps.installer(repository).cancel(entry.downloadToken)
      } catch (error) {
        this.deps.logger?.warn(
          `market download: could not clean up the abandoned staging of "${key}": ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
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
    await this.sweepStalePending()
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
    this.pending.set(key, {
      token,
      reviewExpiresAt: now.getTime() + ttl,
      version: ref,
      classification: review.classification,
      note: review.note,
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
    const pending = this.pending.get(key)
    if (pending === undefined) {
      throw new MarketControlError(
        'market/confirm-required',
        `Downloading "${slug}" needs a previewInstall() confirmation for this ref first.`,
        { key },
      )
    }
    if (pending.token !== confirmToken) {
      throw new MarketControlError(
        'market/confirm-invalid',
        `The download confirmation token for "${slug}" does not match.`,
        { key },
      )
    }
    const now = (this.deps.now ?? (() => new Date()))()
    if (now.getTime() >= pending.reviewExpiresAt) {
      this.pending.delete(key)
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

    const installer = this.deps.installer(repository)
    const prepared = await installer.prepare({
      repositoryRoot: repository.root,
      key,
      repository: slug,
      ...(kind === undefined ? {} : { refKind: kind }),
      version: ref ?? pending.version ?? null,
    })
    // Single use: the confirmation is spent now that a download exists for it.
    this.pending.set(key, {
      token: confirmToken,
      reviewExpiresAt: pending.reviewExpiresAt,
      version: pending.version,
      classification: pending.classification,
      note: pending.note,
      downloadToken: prepared.token,
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
   * this method raises is an unknown/expired handle (`record/not-found`).
   */
  async classifyDownload(token: string): Promise<DownloadClassification> {
    const repository = this.requireRepository()
    const entry = this.requireDownload(token)
    const installer = this.deps.installer(repository)
    return await installer.classify(entry.downloadToken)
  }

  /**
   * Phase 3 of the download channel — swap the staged checkout into place and
   * file the record under the classification the caller chose.
   *
   * Post-rename inconsistency: the host swaps the checkout in before it writes
   * the record, so a failure between the two leaves the new checkout on disk
   * with the previous record (or none) still in `plugins.json`. That cannot be
   * repaired automatically here, so the failure is surfaced with
   * `details.repair = 'checkout-committed-record-missing'` and logged loudly:
   * the operator can fix it by re-running the download (idempotent) or by
   * removing the checkout by hand. Every other commit failure leaves the
   * previous checkout/record untouched (see the host phase contract).
   */
  async commitDownload(token: string, classification: string): Promise<DownloadCommit> {
    const repository = this.requireRepository()
    const entry = this.requireDownload(token)
    const label = requireClassification(classification)
    const before = await repository.records.get(entry.key)
    const installer = this.deps.installer(repository)
    let committed: CommittedDownloadFacts
    try {
      committed = await installer.commit({ token: entry.downloadToken, classification: label })
    } catch (error) {
      this.abandonDownload(entry.key, entry.downloadToken)
      await this.reportCommitInconsistency(entry.key, before, error)
      throw error
    }
    this.pending.delete(entry.key)
    await this.deps.syncRecord(committed.record)
    return {
      key: entry.key,
      overwritten: committed.overwritten,
      record: committed.record,
      checkoutDir: committed.checkoutDir,
      classification: committed.classification,
      entry: committed.entry,
      dependenciesInstalled: committed.dependenciesInstalled,
      note: committed.note,
    }
  }

  /**
   * Cancel a staged download (the "取消并清理暂存" action): the host removes the
   * staging directory — zero residue — and forgets the handle, and the pending
   * entry is dropped. Idempotent: an unknown, already-cancelled or committed
   * handle resolves to `false` without touching the filesystem.
   */
  async cancelDownload(token: string): Promise<boolean> {
    const repository = this.deps.repository()
    const entry = this.findDownload(token)
    if (entry === undefined) return false
    const cancelled = repository === null
      ? false
      : await this.deps.installer(repository).cancel(entry.downloadToken)
    if (cancelled) this.pending.delete(entry.key)
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

  /** The pending entry a download handle belongs to, or undefined. */
  private findDownload(token: string): { readonly key: PluginMarketKey; readonly downloadToken: DownloadHandle } | undefined {
    for (const [key, entry] of this.pending) {
      if (entry.downloadToken === token) return { key, downloadToken: token as DownloadHandle }
    }
    return undefined
  }

  /** Resolve a download handle or fail with the stable not-found code. */
  private requireDownload(token: string): {
    readonly key: PluginMarketKey
    readonly downloadToken: DownloadHandle
  } {
    const found = this.findDownload(token)
    if (found === undefined) {
      throw new MarketControlError('record/not-found', DOWNLOAD_HANDLE_LOST, { path: token })
    }
    return found
  }

  /** Drop the in-memory handle of one download (after commit/cancel/failure). */
  private abandonDownload(key: PluginMarketKey, token: DownloadHandle): void {
    const entry = this.pending.get(key)
    if (entry === undefined || entry.downloadToken !== token) return
    this.pending.set(key, {
      token: entry.token,
      reviewExpiresAt: entry.reviewExpiresAt,
      version: entry.version,
      classification: entry.classification,
      note: entry.note,
    })
  }

  /**
   * Detect and report the post-rename inconsistency of a failed commit: the
   * record no longer matches the checkout the host swapped in. The detection is
   * evidence-based (the record we read before the commit is gone or different),
   * so a failure that happened BEFORE the swap — the common case, where the old
   * record is untouched — is not misreported.
   *
   * The refusal carries `details.reason = 'repair:checkout-committed-record-missing'`
   * so a consumer can tell this state apart from an ordinary `install/io`
   * failure and route it to manual repair.
   */
  private async reportCommitInconsistency(
    key: PluginMarketKey,
    before: PluginMarketRecord | null,
    error: unknown,
  ): Promise<void> {
    if (errorCodeOf(error) !== 'install/io') return
    const repository = this.deps.repository()
    if (repository === null) return
    let after: PluginMarketRecord | null
    try {
      after = await repository.records.get(key)
    } catch {
      return
    }
    const sameRecord = before !== null && after !== null && after.installedAt === before.installedAt
    const recordMissing = before === null && after === null
    if (sameRecord || recordMissing) return
    this.deps.logger?.error(
      `market download: "${key}" was swapped into place but its record could not be written — the checkout on disk no longer matches the record. Re-run the download (idempotent) or remove the checkout manually.`,
    )
    throw new MarketControlError(
      'install/io',
      `${error instanceof Error ? error.message : String(error)} The checkout was already swapped into place, so the record no longer matches it and needs manual repair (re-run the download or remove the checkout).`,
      { key, reason: 'repair:checkout-committed-record-missing' },
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