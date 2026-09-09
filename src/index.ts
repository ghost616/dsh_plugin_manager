/**
 * dsh-plugin-market Host loader entry 鈥?`plugin-market-host` and package
 * composer.
 *
 * Activation contract:
 * - Config (single source: host/market/config.ts, re-exported through
 *   host/market/index.ts) carries one optional `repositoryPath`. When it is
 *   absent or blank the plugin market stays idle (nothing to manage yet)
 *   until the setting is configured.
 * - When configured, activation validates the path (nonexistent / not a
 *   directory / not writable 鈥?each a stable `repository/*` error with a
 *   friendly message), initializes the manager-owned layout, opens the
 *   records file v1 and links the running instance's `@deepseek-ai/*` harness
 *   packages into the repository's shared scope (single Cordis runtime).
 * - The opened repository is published as the `marketRepository` Cordis
 *   service, then the record-driven market control is activated as a child
 *   plugin (plugin-market-control) in the SAME context 鈥?it is no longer a
 *   standalone Loader row. The child fiber resolves `marketRepository` and
 *   `loader` from this context chain and is torn down together with this row.
 * - All business logic lives under `src/host/market/` and `src/host/control/`;
 *   this module only glues Config normalization to the repository open flow
 *   and the control activation.
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import {
  MarketRepositoryService,
  normalizeMarketConfig,
  openMarketRepository,
  type Config,
  type MarketConfig,
} from './host/market/index.ts'
import { marketControlPlugin } from './host/control/index.ts'

/** Stable plugin name; must not contain the loader-forbidden colon. */
export const name = 'plugin-market-host'

/** Host services this plugin needs to activate (none: filesystem only). */
export const inject: readonly string[] = []

// The user-facing Config type is the host/market/config.ts single source
// (re-exported by host/market/index.ts). Re-export it so the package root
// keeps the same typed Config surface without a local duplicate definition.
export type { Config, MarketConfig }

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
  // Publish the opened repository as a Cordis service and activate the record
  // driven control in the same context: ctx.plugin resolves the control's
  // inject ('marketRepository', 'loader') from this context chain, so the
  // repository is opened exactly once and both halves share one lifecycle.
  // The normalized market Config's optional llm section is forwarded as the
  // control activation Config, enabling the smart-install analyzer when the
  // market row configured provider/model.
  new MarketRepositoryService(ctx, repository)
  const controlConfig = resolved.llm === undefined ? undefined : { llm: resolved.llm }
  const activated = controlConfig === undefined
    ? ctx.plugin(marketControlPlugin)
    : ctx.plugin(marketControlPlugin, controlConfig)
  void activated.then(
    () => undefined,
    (error: unknown) => {
      logger.error(`plugin-market-control failed to activate: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
  logger.info(`Plugin source repository ready at ${repository.root} (${repository.harnessLinks.links.length} shared harness link(s), single instance: ${repository.harnessVerified?.singleInstance ?? 'n/a'}).`)
}