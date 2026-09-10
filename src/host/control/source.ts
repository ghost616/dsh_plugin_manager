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
  PluginInstallOutcome,
  PluginInstallReview,
  PluginInstallReviewAnalysis,
  MarketInstallNote,
  PluginMarketClassification,
  PluginMarketKey,
  PluginMarketRecord,
  PluginPreviewOutcome,
  RepositoryDetail,
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

/** One install handed to the host pipeline (already TrustGate-confirmed). */
export interface SourceInstallInput {
  readonly repositoryRoot: string
  readonly key: PluginMarketKey
  /** Validated `owner/repo` slug. */
  readonly repository: string
  /**
   * v2 ref kind of the install. When set, the key is the per-ref tuple key of
   * `pluginKeyForGithubRef(repository, refKind, version)` and the host places
   * the checkout at `<owner>/<repo>/<kind>/<refSeg>`. When absent the install
   * is legacy-compatible: the slug-derived key and single-level checkout are
   * kept, and `version` acts as the pre-v2 pin.
   */
  readonly refKind?: 'branch' | 'tag'
  /** Optional tag/branch pin; the ref name of a v2 install when refKind is set. */
  readonly version: string | null
  /**
   * Classification hint reviewed by `previewInstall`. It never overrides the
   * checkout: the host installer probes the real entry first and files a
   * checkout carrying a runnable entry as `plugin` regardless of this value;
   * the hint only narrows the tag of an entry-less checkout (`skills`, else
   * `other`).
   */
  readonly classification?: PluginMarketClassification
}

/** Install engine surface of the host installer. */
export interface InstallerPort {
  install(input: SourceInstallInput): Promise<InstalledPluginFacts>
}

/**
 * What the host installer reports after it inspected and filed the checkout.
 * These are install-time facts (the entry probe wins over the review
 * prediction), so they are what the caller surfaces back to the consumer.
 */
export interface InstalledPluginFacts {
  readonly record: PluginMarketRecord
  readonly checkoutDir: string
  /** Classification the checkout was actually filed under. */
  readonly classification: PluginMarketClassification
  /** Runnable entry that was registered, or null when the checkout has none. */
  readonly entry: string | null
  /** Host note explaining a null entry (unreadable manifest / missing entry). */
  readonly entryNote: string | null
  /** Whether the dependency step (`pnpm install`) actually ran. */
  readonly dependenciesInstalled: boolean
}

/** Everything the source operations need from its environment. */
export interface MarketSourceDeps {
  /** The active repository, or null while the market is idle. */
  readonly repository: () => MarketRepository | null
  readonly searchEngine: SearchEnginePort
  readonly detailEngine: RepositoryDetailPort
  readonly previewEngine: PreviewEnginePort
  /** Builds the install engine bound to one opened repository. */
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
 * One pending install confirmation, keyed by the derived install key. Only the
 * facts the later `install()` call needs are kept: the token/expiry, the
 * reviewed ref, and the classification hint. The review's analyzer verdict is
 * NOT stored — nothing reads it at install time (the checkout itself is the
 * authority), so keeping it would be a second, stale copy of review state.
 */
interface PendingInstall {
  readonly token: string
  readonly expiresAt: number
  readonly version: string | null
  /**
   * Classification the review predicted for this checkout. It is handed to the
   * installer as a hint only: the host entry probe decides the tag actually
   * filed.
   */
  readonly classification: PluginMarketClassification
  /** Review note rendered on the review (absence = a runnable entry is expected). */
  readonly note: MarketInstallNote | null
}

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
 * The market's source operations. Never throws for a healthy idle market with
 * a message a caller can show; all failures carry stable wire codes.
 */
export class MarketSourceOperations {
  private readonly pending = new Map<string, PendingInstall>()

  constructor(private readonly deps: MarketSourceDeps) {}

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
      expiresAt: now.getTime() + ttl,
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
   * Run the confirmed install (single-use token, protection re-check). The
   * refKind/version pair must match the reviewed tuple: tokens are bound to
   * the derived key, so a branch and a tag of the same name each need (and
   * consume) their own confirmation.
   *
   * The classification reviewed by {@link previewInstall} rides into the host
   * installer, so a checkout the review predicted as a non-plugin is filed
   * with that tag and a null entry instead of being refused — the download
   * always runs, and the control layer withholds only the loader registration
   * (`market/not-loadable` on enable).
   */
  async install(
    repositoryRaw: string,
    confirmToken: string,
    refKind: string | null = null,
    version: string | null = null,
  ): Promise<PluginInstallOutcome> {
    const repository = this.requireRepository()
    const slug = parseRepositorySlug(repositoryRaw)
    const kind = normalizeRefKind(refKind)
    const ref = kind === undefined ? version : requireRefName(slug, kind, version)
    const key = deriveInstallKey(slug, kind, ref)
    const pending = this.pending.get(key)
    if (pending === undefined) {
      throw new MarketControlError(
        'market/confirm-required',
        `Installing "${slug}" needs a previewInstall() confirmation for this ref first.`,
        { key },
      )
    }
    if (pending.token !== confirmToken) {
      throw new MarketControlError(
        'market/confirm-invalid',
        `The install confirmation token for "${slug}" does not match.`,
        { key },
      )
    }
    const now = (this.deps.now ?? (() => new Date()))()
    if (now.getTime() >= pending.expiresAt) {
      this.pending.delete(key)
      throw new MarketControlError(
        'market/confirm-expired',
        `The install confirmation for "${slug}" expired; review the plugin again.`,
        { key },
      )
    }
    this.pending.delete(key)

    const existing = await repository.records.get(key)
    if (existing !== null) this.assertOverwriteAllowed(existing, repository)

    const installer = this.deps.installer(repository)
    const outcome = await installer.install({
      repositoryRoot: repository.root,
      key,
      repository: slug,
      ...(kind === undefined ? {} : { refKind: kind }),
      version: ref ?? pending.version ?? null,
      classification: pending.classification,
    })
    await this.deps.syncRecord(outcome.record)
    // The install-time facts (the entry probe wins over the review prediction)
    // are surfaced back verbatim, so a consumer sees what was really filed.
    return {
      key,
      overwritten: existing !== null,
      record: outcome.record,
      checkoutDir: outcome.checkoutDir,
      classification: outcome.classification,
      entry: outcome.entry,
      entryNote: outcome.entryNote,
      dependenciesInstalled: outcome.dependenciesInstalled,
    }
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