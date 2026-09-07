/**
 * dsh-plugin-market Host loader entry — `plugin-market-host`.
 *
 * Activation contract:
 * - Config carries one optional `repositoryPath`. When it is absent or blank
 *   the plugin market stays idle (nothing to manage yet) until the setting is
 *   configured.
 * - When configured, activation validates the path (nonexistent / not a
 *   directory / not writable — each a stable `repository/*` error with a
 *   friendly message), initializes the manager-owned layout, opens the
 *   records file v1 and links the running instance's `@deepseek-ai/*` harness
 *   packages into the repository's shared scope (single Cordis runtime).
 * - All business logic lives under `src/host/market/`; this module only glues
 *   Config normalization to the repository open flow.
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  normalizeMarketConfig,
  type MarketConfig,
} from './host/market/config.ts'
import { openMarketRepository } from './host/market/index.ts'
import { MarketRepositoryService } from './host/market/service.ts'

/** Stable plugin name; must not contain the loader-forbidden colon. */
export const name = 'plugin-market-host'

/** Host services this plugin needs to activate (none: filesystem only). */
export const inject: readonly string[] = []

/**
 * User-facing Config of the Host plugin. Only `repositoryPath` is a user
 * setting; activation defaults (create-if-missing, harness linking) are
 * decided by the repository layer.
 */
export interface Config {
  /**
   * Directory of the local third-party plugin source repository (absolute, or
   * relative to the process cwd; a leading `~` expands to the home
   * directory). Omit it to keep the plugin market idle.
   */
  readonly repositoryPath?: string
}

export type { MarketConfig }

/**
 * Activate the Host half. Async: the loader awaits repository initialization,
 * so a misconfigured repository path fails this plugin loudly at startup.
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  const logger = ctx.logger('plugin-market-host')
  const resolved: MarketConfig = normalizeMarketConfig(config, {
    cwd: process.cwd(),
    home: homedir(),
  })
  if (resolved.repositoryPath === null) {
    logger.warn('Plugin market stays idle: Config.repositoryPath is not set. Configure the local third-party plugin source repository to activate it.')
    return
  }
  const repository = await openMarketRepository(resolved.repositoryPath, {
    createIfMissing: resolved.createIfMissing,
    linkSharedHarness: resolved.linkSharedHarness,
  })
  // Publish the opened repository as a Cordis service so the market control
  // row reacts to its presence (and to repository configuration changes)
  // without ever opening the directory twice.
  new MarketRepositoryService(ctx, repository)
  logger.info(`Plugin source repository ready at ${repository.root} (${repository.harnessLinks.links.length} shared harness link(s), single instance: ${repository.harnessVerified?.singleInstance ?? 'n/a'}).`)
}
