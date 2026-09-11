/**
 * MarketControllerGateway — the authoritative Remote surface of the market
 * control service, following the shipped plugin-inventory gateway pattern
 * (TypertRemoteService + @Remote markers).
 *
 * The gateway stays mounted while the market is idle and answers
 * `market/idle` for every repository-backed operation (configure
 * Config.repositoryPath on plugin-market-host to use them). A dsh composition
 * routes this service automatically through its source-mode Gateway
 * discovery (`collectSrcClaims` enumerates live Services carrying a
 * `typertRemote` binding), so no generated descriptor artifact is required on
 * the Host. Every public method throws {@link RemoteError} with the merged
 * market wire codes (see `src/types.ts`), keeping failures identical across
 * the native Remote carrier and the external web channel.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Remote,
  RemoteError,
  TypertRemoteService,
  remoteErrorOf,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  GitHubSearchPage,
  GitHubTokenStatus,
  GitHubTokenUpdateResult,
  ManagedPluginList,
  MarketStatus,
  PluginInstallReview,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
  RepositoryDetail,
} from '../../types.ts'
import type { MarketRepository } from '../market/index.ts'
import { parsePluginKey } from '../market/keys.ts'
import { MarketError } from '../market/errors.ts'
import { MarketControlError, type MarketPluginController } from './controller.ts'
import { requireClassification, wireDetailsOf, type DownloadClassification, type DownloadCommit, type DownloadPreparation, type MarketSourceOperations } from './source.ts'

/** The Cordis service key (and wire namespace) of the gateway. */
export const MARKET_CONTROL_SERVICE_KEY = 'marketControl'

/**
 * Explicit read options of the browse/detail surface, as they cross the Remote
 * wire (the host client's own `GitHubReadOptions` shape).
 *
 * They are declared here rather than imported from the host engine so the wire
 * contract of the gateway is readable on its own; the fields are structurally
 * identical, so a caller of either side compiles against both. `refresh` is the
 * page's explicit "go to GitHub again" flag and `signal` is a caller-provided
 * cancellation token (only meaningful across the in-process Remote carrier —
 * a JSON transport cannot carry an `AbortSignal`).
 */
export interface GitHubReadWireOptions {
  readonly refresh?: boolean
  readonly signal?: AbortSignal
}

/** Live access the gateway needs from its activation context. */
export interface MarketControllerGatewayDeps {
  /** The record-driven controller, or null while the market is idle. */
  readonly controller: () => MarketPluginController | null
  /** The active repository, or null while the market is idle. */
  readonly repository: () => MarketRepository | null
  /** Source operations (search / preview / install). */
  readonly source: MarketSourceOperations
  /**
   * Drop the host GitHub client's read-only TTL cache and report whether
   * anything was actually dropped.
   *
   * REQUIRED, like `source.token`: every token write must invalidate what the
   * market memoized, or the next GitHub call would keep answering from the
   * cache while the surface claims the new token is live. The report is the
   * boolean `cacheCleared` the wire carries — `false` only means nothing was
   * memoized at that moment, never that the old token is still in effect. An
   * assembly whose engine has no cache wires a `() => false` reporter instead
   * of omitting it, so "forgot to clear" cannot be expressed.
   */
  readonly clearGitHubCache: () => boolean
}

/**
 * Prefixes owned by the market wire vocabulary; structural recognition keeps
 * failures canonical even when an error class crossed a bundle boundary.
 */
const MARKET_WIRE_CODE_PREFIXES = [
  'market/', 'record/', 'repository/', 'harness/', 'config/',
  'github/', 'install/', 'gate/', 'registry/',
] as const

function isWireErrorLike(error: unknown): error is { code: string; message: string; details?: unknown } {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return false
  return MARKET_WIRE_CODE_PREFIXES.some(prefix => code.startsWith(prefix))
}

/** Parse a wire key, mapping invalid input to the stable wire failure. */
function wireKey(key: string): PluginMarketKey {
  try {
    return parsePluginKey(key)
  } catch (error) {
    throw toRemoteError(error)
  }
}

/** One canonical wire failure for any caught value. */
export function toRemoteError(error: unknown): RemoteError {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) {
    // Instances rebuilt across realms already carry the wire shape.
    return remote as unknown as RemoteError
  }
  if (error instanceof MarketControlError) {
    return new RemoteError(
      error.code as never,
      error.message,
      error.details as never,
      { cause: error },
    )
  }
  if (error instanceof MarketError) {
    // Host failures carry machine-readable details (`details.swapCompleted`,
    // `details.checkoutDir`, `details.key`, …). Only the fields the shared
    // `MarketRemoteErrorDetails` declares travel on the wire — they are
    // normalized rather than forwarded verbatim, so the wire contract stays
    // exactly as wide as `src/types.ts` says it is.
    return new RemoteError(
      error.code as never,
      error.message,
      wireDetailsOf(error) as never,
      { cause: error },
    )
  }
  if (isWireErrorLike(error)) {
    // A market/record/repository/github/install failure thrown from another
    // copy of this package (e.g. src code under a compiled gateway) still maps
    // by shape.
    return new RemoteError(
      error.code as never,
      error.message,
      wireDetailsOf(error) as never,
      { cause: error },
    )
  }
  if (error instanceof Error) {
    return new RemoteError(
      'gateway/internal',
      error.message,
      {},
      { cause: error },
    )
  }
  return new RemoteError('gateway/internal', String(error), {})
}

/** Remote exposure of the market control service. */
export class MarketControllerGateway extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly deps: MarketControllerGatewayDeps,
  ) {
    super(ctx, MARKET_CONTROL_SERVICE_KEY)
  }

  /** Resolve the active controller; repository-backed ops idle otherwise. */
  private requireController(): MarketPluginController {
    const controller = this.deps.controller()
    if (controller === null) {
      throw new MarketControlError(
        'market/idle',
        'The plugin market is idle: configure Config.repositoryPath on plugin-market-host to manage plugins.',
      )
    }
    return controller
  }

  /** Read-only activation facts (configured flag + repository root). */
  @Remote('status')
  async status(): Promise<MarketStatus> {
    const repository = this.deps.repository()
    return repository === null
      ? { configured: false, repositoryPath: null }
      : { configured: true, repositoryPath: repository.root }
  }

  /** Records merged with the live loader projection, in stable key order. */
  @Remote('listManaged')
  async listManaged(): Promise<ManagedPluginList> {
    try {
      return await this.requireController().list()
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Persist the intent and apply it to the loader entry. */
  @Remote('setEnabled')
  async setEnabled(key: string, enabled: boolean): Promise<PluginMarketRecord> {
    try {
      return await this.requireController().setEnabled(wireKey(key), enabled)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Step 1 of the double-confirmed removal protocol. */
  @Remote('requestRemove')
  async requestRemove(key: string): Promise<RemoveRequest> {
    try {
      return await this.requireController().requestRemove(wireKey(key))
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Step 2 of the double-confirmed removal protocol. */
  @Remote('confirmRemove')
  async confirmRemove(key: string, token: string): Promise<RemoveOutcome> {
    try {
      return await this.requireController().confirmRemove(wireKey(key), token)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** GitHub topic search (dsh-plugin); page is 1-based (null ⇒ page 1). */
  @Remote('search')
  async search(
    keywords: string | null,
    perPage: number | null,
    page: number | null,
    options?: GitHubReadWireOptions,
  ): Promise<GitHubSearchPage> {
    try {
      return await this.deps.source.search({
        ...(keywords === null || keywords === undefined ? {} : { keywords }),
        ...(perPage === null || perPage === undefined ? {} : { perPage }),
        page: page === null || page === undefined ? 1 : page,
        ...(options?.refresh === undefined ? {} : { refresh: options.refresh }),
      })
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /**
   * Aggregated detail (metadata + branches + tags + README) of one repository.
   * `options.refresh` skips the host's read-only TTL cache for all four queries
   * (the detail page's explicit refresh); omitting it keeps the cached answer.
   */
  @Remote('repositoryDetail')
  async repositoryDetail(
    repository: string,
    options?: GitHubReadWireOptions,
  ): Promise<RepositoryDetail> {
    try {
      // exactOptionalPropertyTypes: never forward an explicit `undefined` key —
      // an absent option has to stay absent so the engine keeps its default.
      return await this.deps.source.repositoryDetail(repository, {
        ...(options?.refresh === undefined ? {} : { refresh: options.refresh }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /**
   * Read-only GitHub token status (configured / source / writable / effective
   * reference). Deliberately answerable while the market is idle: the token is
   * a deployment-wide fact, so a settings page can show it — and receive the
   * stable `github/token-unavailable` when this deployment mounted no
   * credential seam — before any repository exists.
   */
  @Remote('tokenStatus')
  async tokenStatus(): Promise<GitHubTokenStatus> {
    try {
      return await this.deps.source.tokenStatus()
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /**
   * Save one GitHub token through the credential seam and answer the status
   * re-read after the write (plus the cache report). An empty value is
   * `github/bad-request` and a read-only launch environment is
   * `github/token-unavailable`; nothing is written in either case.
   */
  @Remote('saveGitHubToken')
  async saveGitHubToken(value: string | null): Promise<GitHubTokenUpdateResult> {
    try {
      const status = await this.deps.source.saveGitHubToken(value)
      return { status, cacheCleared: this.deps.clearGitHubCache() }
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /**
   * Clear the GitHub token through the credential seam and answer the status
   * re-read after the removal (plus the cache report). A read-only launch
   * environment is refused exactly like a save.
   */
  @Remote('clearGitHubToken')
  async clearGitHubToken(): Promise<GitHubTokenUpdateResult> {
    try {
      const status = await this.deps.source.clearGitHubToken()
      return { status, cacheCleared: this.deps.clearGitHubCache() }
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /**
   * Review one repository (or one of its refs) and mint its single-use install
   * confirmation. `refKind` null/omitted ⇒ legacy default-branch review;
   * `'branch'`/`'tag'` ⇒ that ref's per-tuple review (requires `version`).
   */
  @Remote('previewInstall')
  async previewInstall(
    repository: string,
    refKind: string | null,
    version: string | null,
  ): Promise<PluginInstallReview> {
    try {
      return await this.deps.source.previewInstall(repository, refKind ?? null, version ?? null)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /**
   * Phase 1 of the download channel: consume the single-use review
   * confirmation and clone the checkout into the host's staging area. The
   * `refKind`/`version` pair must reproduce the reviewed tuple (the token is
   * bound to its derived key).
   */
  @Remote('prepareDownload')
  async prepareDownload(
    repository: string,
    confirmToken: string,
    refKind: string | null,
    version: string | null,
  ): Promise<DownloadPreparation> {
    try {
      return await this.deps.source.prepareDownload(repository, confirmToken, refKind ?? null, version ?? null)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Phase 2: classify the staged checkout (model problems never throw). */
  @Remote('classifyDownload')
  async classifyDownload(token: string): Promise<DownloadClassification> {
    try {
      return await this.deps.source.classifyDownload(token)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Phase 3: swap the staged checkout in and file it under `classification`. */
  @Remote('commitDownload')
  async commitDownload(token: string, classification: string): Promise<DownloadCommit> {
    try {
      return await this.deps.source.commitDownload(token, classification)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Cancel a staged download (idempotent; false when it is unknown/consumed). */
  @Remote('cancelDownload')
  async cancelDownload(token: string): Promise<boolean> {
    try {
      return await this.deps.source.cancelDownload(token)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /**
   * Correct the classification of an already-filed record (the manual fix after
   * an `unclassified`/`failed` download). The value is validated here so a bad
   * label fails with the stable `market/bad-request` before reaching the host
   * store (which answers `record/invalid` for an unknown tag).
   */
  @Remote('setClassification')
  async setClassification(key: string, classification: string): Promise<PluginMarketRecord> {
    try {
      const label = requireClassification(classification)
      return await this.requireController().setClassification(wireKey(key), label)
    } catch (error) {
      throw toRemoteError(error)
    }
  }
}
