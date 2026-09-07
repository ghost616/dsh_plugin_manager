/**
 * MarketControllerGateway — the authoritative Remote surface of the market
 * control service, following the shipped plugin-inventory gateway pattern
 * (TypertRemoteService + @Remote markers).
 *
 * A dsh composition routes this service automatically through its source-mode
 * Gateway discovery: `collectSrcClaims()` enumerates every live Service that
 * carries a `typertRemote` binding, so no generated descriptor artifact is
 * required on the Host. Every public method throws {@link RemoteError} with
 * the merged market wire codes (see `src/types.ts`), which keeps failures
 * identical across the native Remote carrier and the external web channel.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Remote,
  RemoteError,
  TypertRemoteService,
  remoteErrorOf,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  ManagedPluginList,
  PluginMarketKey,
  PluginMarketRecord,
  RemoveOutcome,
  RemoveRequest,
} from '../../types.ts'
import { parsePluginKey } from '../market/keys.ts'
import { MarketError } from '../market/errors.ts'
import { MarketControlError, type MarketPluginController } from './controller.ts'

/** The Cordis service key (and wire namespace) of the gateway. */
export const MARKET_CONTROL_SERVICE_KEY = 'marketControl'

/**
 * Prefixes owned by the market wire vocabulary; structural recognition keeps
 * failures canonical even when an error class crossed a bundle boundary.
 */
const MARKET_WIRE_CODE_PREFIXES = [
  'market/', 'record/', 'repository/', 'harness/', 'config/',
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
    // A market/record/repository failure thrown from another copy of this
    // package (e.g. src code under a compiled gateway) still maps by shape.
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

/** Remote exposure of the record-driven controller. */
export class MarketControllerGateway extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly controller: MarketPluginController,
  ) {
    super(ctx, MARKET_CONTROL_SERVICE_KEY)
  }

  /** Records merged with the live loader projection, in stable key order. */
  @Remote('listManaged')
  async listManaged(): Promise<ManagedPluginList> {
    try {
      return await this.controller.list()
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Persist the intent and apply it to the loader entry. */
  @Remote('setEnabled')
  async setEnabled(key: string, enabled: boolean): Promise<PluginMarketRecord> {
    try {
      return await this.controller.setEnabled(wireKey(key), enabled)
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Step 1 of the double-confirmed removal protocol. */
  @Remote('requestRemove')
  async requestRemove(key: string): Promise<RemoveRequest> {
    try {
      return await this.controller.requestRemove(wireKey(key))
    } catch (error) {
      throw toRemoteError(error)
    }
  }

  /** Step 2 of the double-confirmed removal protocol. */
  @Remote('confirmRemove')
  async confirmRemove(key: string, token: string): Promise<RemoveOutcome> {
    try {
      return await this.controller.confirmRemove(wireKey(key), token)
    } catch (error) {
      throw toRemoteError(error)
    }
  }
}