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
 *   bound to the repository slug;
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
  PluginMarketKey,
  PluginMarketRecord,
  PluginPreviewOutcome,
  RepositoryDetail,
} from '../../types.ts'
import type { MarketRepository } from '../market/index.ts'
import { parseRepositorySlug, type GitHubRepoMeta } from '../market/github.ts'
import { parsePluginKey } from '../market/keys.ts'
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
  /** Optional tag/branch pin. */
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
  /** Optional structured logger. */
  readonly logger?: ControlLogger
}

/** One pending install confirmation, keyed by the repository slug. */
interface PendingInstall {
  readonly token: string
  readonly expiresAt: number
  readonly version: string | null
}

/** Derive the stable loader key of a repository slug (`gh-owner-repo`). */
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

  /** Review one repository and mint its single-use install confirmation. */
  async previewInstall(repositoryRaw: string, version: string | null = null): Promise<PluginInstallReview> {
    const repository = this.requireRepository()
    const slug = parseRepositorySlug(repositoryRaw)
    const key = pluginKeyForRepository(slug)
    const existing = await repository.records.get(key)
    if (existing !== null) this.assertOverwriteAllowed(existing, repository)

    const preview = await this.deps.previewEngine.preview(slug)
    const token = randomBytes(16).toString('hex')
    const now = (this.deps.now ?? (() => new Date()))()
    const ttl = this.deps.confirmTtlMs ?? REMOVE_CONFIRM_TTL_MS
    this.pending.set(slug, {
      token,
      expiresAt: now.getTime() + ttl,
      version,
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
    }
  }

  /** Run the confirmed install (single-use token, protection re-check). */
  async install(
    repositoryRaw: string,
    confirmToken: string,
    version: string | null = null,
  ): Promise<PluginInstallOutcome> {
    const repository = this.requireRepository()
    const slug = parseRepositorySlug(repositoryRaw)
    const pending = this.pending.get(slug)
    if (pending === undefined) {
      throw new MarketControlError(
        'market/confirm-required',
        `Installing "${slug}" needs a previewInstall() confirmation first.`,
        { key: pluginKeyForRepository(slug) },
      )
    }
    if (pending.token !== confirmToken) {
      throw new MarketControlError(
        'market/confirm-invalid',
        `The install confirmation token for "${slug}" does not match.`,
        { key: pluginKeyForRepository(slug) },
      )
    }
    const now = (this.deps.now ?? (() => new Date()))()
    if (now.getTime() >= pending.expiresAt) {
      this.pending.delete(slug)
      throw new MarketControlError(
        'market/confirm-expired',
        `The install confirmation for "${slug}" expired; review the plugin again.`,
        { key: pluginKeyForRepository(slug) },
      )
    }
    this.pending.delete(slug)

    const key = pluginKeyForRepository(slug)
    const existing = await repository.records.get(key)
    if (existing !== null) this.assertOverwriteAllowed(existing, repository)

    const installer = this.deps.installer(repository)
    const outcome = await installer.install({
      repositoryRoot: repository.root,
      key,
      repository: slug,
      version: version ?? pending.version ?? null,
    })
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