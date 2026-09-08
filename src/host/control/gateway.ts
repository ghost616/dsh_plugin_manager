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
  ManagedPluginList,
  MarketStatus,
  PluginInstallOutcome,
  PluginInstallReview,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
} from '../../types.ts'
import type { MarketRepository } from '../market/index.ts'
import { parsePluginKey } from '../market/keys.ts'
import { MarketError } from '../market/errors.ts'
import { MarketControlError, type MarketPluginController } from './controller.ts'
import type { MarketSourceOperations } from './source.ts'

/** The Cordis service key (and wire namespace) of the gateway. */
export const MARKET_CONTROL_SERVICE_KEY = 'marketControl'

/** Live access the gateway needs from its activation context. */
export interface MarketControllerGatewayDeps {
  /** The record-driven controller, or null while the market is idle. */
  readonly controller: () => MarketPluginController | null
  /** The active repository, or null while the market is idle. */
  readonly repository: () => MarketRepository | null
  /** Source operations (search / preview / install). */
  readonly source: MarketSourceOperations
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
    return new RemoteError(
      error.code as never,
      error.message,
      {} as never,
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
      error.details as never,
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
  async search(keywords: string | null, perPage: number | null, page: number | null): Promise<GitHubSearchPage> {
    try {
      return await this.deps.source.search({
        ...(keywords === null || keywords === undefined ? {} : { keywords }),
        ...(perPage === null || perPage === undefined ? {} : { perPage }),
        page: page === null || page === undefined ? 1 : page,
      })
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Review one repository and mint its single-use install confirmation. */
  @Remote('previewInstall')
  async previewInstall(repository: string, version: string | null): Promise<PluginInstallReview> {
    try {
      return await this.deps.source.previewInstall(repository, version ?? null)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Run the double-confirmed install for a reviewed repository. */
  @Remote('install')
  async install(repository: string, confirmToken: string, version: string | null): Promise<PluginInstallOutcome> {
    try {
      return await this.deps.source.install(repository, confirmToken, version ?? null)
    } catch (error) {
      throw toRemoteError(error)
    }
  }
}
