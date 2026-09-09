/**
 * Source operations of the market control surface: GitHub search, repository
 * detail (metadata + branches + tags + README), install preview and the
 * double-confirmed install protocol. These reach the local repository only to
 * answer "already managed?" and to run the download; all network and
 * filesystem work is delegated to injectable host-market engines
 * (GitHubMarket / PluginPreviewer / PluginInstaller), keeping this layer free
 * of fetch and subprocess code and fully unit-testable.
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
 *   backend safeguard) and syncs the newly registered (default-disabled)
 *   record into a loader row so listManaged reflects it immediately.
 */

import { randomBytes } from 'node:crypto'
import type {
  GitHubSearchPage,
  PluginInstallOutcome,
  PluginInstallReview,
  PluginInstallReviewAnalysis,
  PluginMarketKey,
  PluginMarketRecord,
  PluginPreviewOutcome,
  RepositoryDetail,
} from '../../types.ts'
import type { MarketRepository } from '../market/index.ts'
import { parseRepositorySlug, type GitHubRepoMeta } from '../market/github.ts'
import { parsePluginKey, pluginKeyForGithubRef } from '../market/keys.ts'
import { entryModuleName } from './entry-name.ts'
import { REMOVE_CONFIRM_TTL_MS, MarketControlError, type ControlLogger } from './controller.ts'
import type { ProtectionPolicy } from './protect.ts'
import { refusalWireCode } from './analysis.ts'

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
}

/** Install engine surface of the host installer. */
export interface InstallerPort {
  install(input: SourceInstallInput): Promise<{ readonly record: PluginMarketRecord; readonly checkoutDir: string }>
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
   * unreadable/absent — no standard npm plugin entry evidence) and surfaces
   * the refusal on the review, while install refuses those candidates up
   * front. Without it the unconventional path rejects with
   * `market/llm-unconfigured` and a model-config hint.
   */
  readonly analysis?: InstallAnalysisEngine
  /** Optional structured logger. */
  readonly logger?: ControlLogger
}

/**
 * One smart-install analysis of an unconventional candidate. The engine
 * classifies the checkout (skills/preset/tooling/other — or a plugin that is
 * only installable after a build) and reports a refusal verdict; a `plugin`
 * with a runnable entry yields `null` (no refusal, install proceeds).
 */
export interface InstallAnalysisEngine {
  /**
   * Classify one candidate whose remote preview showed no readable manifest.
   * @param request - the candidate slug plus the preview outcome that marked
   *   it unconventional.
   * @returns the refusal (installable: false) when the model judged the
   *   checkout not directly installable, or null when it is an installable
   *   plugin.
   * @throws MarketError `market/llm-unconfigured` when the analysis engine
   *   exists but no llm provider/model is configured; `market/llm-failed` /
   *   `market/llm-bad-output` on model failures. The source layer keeps
   *   `market/llm-unconfigured` as-is and normalizes every other failure to
   *   the stable retryable `market/llm-failed` before it reaches the wire.
   */
  analyze(request: {
    readonly repository: string
    readonly preview: PluginPreviewOutcome
  }): Promise<PluginInstallReviewAnalysis | null>
}

/** One pending install confirmation, keyed by the derived install key. */
interface PendingInstall {
  readonly token: string
  readonly expiresAt: number
  readonly version: string | null
  /** Smart-install refusal recorded for this candidate, when it was refused. */
  readonly analysis?: PluginInstallReviewAnalysis
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
 * Friendly build-first guidance appended to `install/entry-missing` failures:
 * the resolved entry is absent because the repository may ship as source and
 * need its documented build step before the plugin entry becomes loadable.
 */
export const ENTRY_MISSING_BUILD_HINT =
  ' If the repository ships as source, run its documented build step to generate the plugin entry, then retry the install.'

/** Rethrow an `install/entry-missing` failure with the build-first hint. */
function enrichEntryMissingError(error: unknown): never {
  if (errorCodeOf(error) === 'install/entry-missing') {
    const message = error instanceof Error ? error.message : String(error)
    throw new MarketControlError('install/entry-missing', `${message}${ENTRY_MISSING_BUILD_HINT}`)
  }
  throw error
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
   * Smart-install analysis: when the remote preview shows an unconventional
   * candidate (no readable package.json on the probed branches — no standard
   * npm plugin entry evidence) the review runs the configured analysis engine
   * first and carries the refusal verdict (`analysis`) when the model judged
   * the checkout not installable (skills/preset/tooling/other, or a plugin
   * that needs a build first). Standard npm plugins (readable manifest) and
   * degraded previews caused by transport failures never run the model. When
   * the market Config configured no llm endpoint, an unconventional candidate
   * is refused outright with `market/llm-unconfigured` and a model-config
   * hint, so the two-step protocol never mints a token for a checkout the
   * market cannot even classify.
   *
   * Analysis failure is never silently allowed: if the analysis of an
   * unconventional candidate itself fails (LLM transport/timeout jitter,
   * unparsable output, engine bugs) the preview rejects with the stable
   * retryable `market/llm-failed` and NO confirmation token is minted — the
   * candidate stays unclassified and cannot be installed, so the UI can simply
   * retry the review.
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
    const analysis = MarketSourceOperations.isUnconventionalPreview(preview)
      ? await this.analyzeCandidate(slug, preview)
      : undefined
    const token = randomBytes(16).toString('hex')
    const now = (this.deps.now ?? (() => new Date()))()
    const ttl = this.deps.confirmTtlMs ?? REMOVE_CONFIRM_TTL_MS
    this.pending.set(key, {
      token,
      expiresAt: now.getTime() + ttl,
      version: ref,
      ...(analysis === undefined ? {} : { analysis }),
    })
    return {
      repository: slug,
      key,
      preview,
      exists: existing !== null,
      overwrite: existing !== null,
      existing,
      confirmToken: token,
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      ...(kind === undefined ? {} : { refKind: kind }),
      ...(analysis === undefined ? {} : { analysis }),
    }
  }

  /**
   * Run the confirmed install (single-use token, protection re-check). The
   * refKind/version pair must match the reviewed tuple: tokens are bound to
   * the derived key, so a branch and a tag of the same name each need (and
   * consume) their own confirmation.
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

    // A smart-install refusal recorded at review time makes the install
    // non-runnable: reject with the unsupported code and the model's reason
    // before the host pipeline runs (no record/checkout is produced).
    if (pending.analysis !== undefined) {
      throw new MarketControlError(
        refusalWireCode(pending.analysis.kind),
        pending.analysis.reason,
        { key },
      )
    }

    const existing = await repository.records.get(key)
    if (existing !== null) this.assertOverwriteAllowed(existing, repository)

    const installer = this.deps.installer(repository)
    let outcome: { readonly record: PluginMarketRecord; readonly checkoutDir: string }
    try {
      outcome = await installer.install({
        repositoryRoot: repository.root,
        key,
        repository: slug,
        ...(kind === undefined ? {} : { refKind: kind }),
        version: ref ?? pending.version ?? null,
      })
    } catch (error) {
      // The host reports a missing runnable entry as install/entry-missing
      // (e.g. an unconventional checkout the model judged a plugin, or a
      // manifest that resolved no main and no conventional index.js exists).
      // Surface the same stable code with a build-first hint so the user knows
      // the repository may ship as source and needs its documented build.
      throw enrichEntryMissingError(error)
    }
    await this.deps.syncRecord(outcome.record)
    return {
      key,
      overwritten: existing !== null,
      record: outcome.record,
      checkoutDir: outcome.checkoutDir,
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
   * checkout needs model classification. Transport failures (network /
   * rate-limit / auth) are not unconventional: the manifest may simply be
   * temporarily unreadable and the review keeps the degraded-but-installable
   * semantics.
   */
  private static isUnconventionalPreview(preview: PluginPreviewOutcome): boolean {
    return preview.status === 'degraded'
      && (preview.code === 'github/not-found' || preview.code === 'github/bad-response')
  }

  /**
   * Run the smart-install analysis of an unconventional candidate and map its
   * verdict onto the review analysis field. A missing analysis engine means
   * the market Config configured no llm endpoint — the candidate is refused
   * with `market/llm-unconfigured` and a model-config hint (see
   * {@link InstallAnalysisEngine}).
   *
   * Failure semantics: an analysis that cannot run NEVER silently allows the
   * install. `market/llm-unconfigured` propagates as-is (a retry cannot fix a
   * missing model endpoint); every other failure — LLM transport/timeout
   * jitter, unparsable output, engine bugs — is normalized to the stable
   * retryable `market/llm-failed`, and because this throws before the review
   * token is minted, the candidate cannot be installed until a review
   * succeeds.
   */
  private async analyzeCandidate(
    slug: string,
    preview: PluginPreviewOutcome,
  ): Promise<PluginInstallReviewAnalysis | undefined> {
    const engine = this.deps.analysis
    if (engine === undefined) {
      throw new MarketControlError(
        'market/llm-unconfigured',
        `"${slug}" does not look like a standard npm plugin, and the smart-install analyzer is not configured. Set Config.llm.provider and Config.llm.model on plugin-market-host to classify and install non-standard checkouts.`,
      )
    }
    let refusal: PluginInstallReviewAnalysis | null
    try {
      refusal = await engine.analyze({ repository: slug, preview })
    } catch (error) {
      // See the failure-semantics note above: only the configuration case
      // keeps its own code; everything else is one stable, retryable failure.
      if (errorCodeOf(error) === 'market/llm-unconfigured') throw error
      throw new MarketControlError(
        'market/llm-failed',
        `The smart-install analysis of "${slug}" failed; the checkout was not classified and cannot be installed. Retry the review, or check the configured LLM provider/model.`,
        {},
        { cause: error },
      )
    }
    // null → the model judged the checkout an installable plugin: no refusal.
    return refusal === null ? undefined : refusal
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