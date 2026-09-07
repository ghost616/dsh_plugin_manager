/**
 * plugin-market-control — Host entry of the market control service.
 *
 * Activation contract:
 * - The row is intentionally passive until two conditions hold: the plugin
 *   market's repository service is provided (plugin-market-host configured a
 *   repository path) and the Cordis Loader service is available. The row waits
 *   on both through `ctx.inject`, so an unconfigured market stays idle without
 *   failing this fiber, and a later configuration change (repositoryPath
 *   added/removed/reloaded) tears the controller down and re-establishes it.
 * - Once ready, it builds the record-driven controller, rebuilds loader rows
 *   only after the loader tree has settled (startup ordering: "include tree
 *   ready, then register records in key order"), publishes the
 *   MarketControllerGateway Remote surface, and — when a webServer exists —
 *   registers the same surface behind the exact `/api/plugins-market` route.
 * - The row never manages loader entries outside the repository records and
 *   never removes its own package rows or protected keys.
 */

import type { Context } from '@deepseek-ai/cordis'
import { MarketPluginController } from './controller.ts'
import { entryDirectoryPath, entryModuleName } from './entry-name.ts'
import { MarketControllerGateway } from './gateway.ts'
import { createLoaderAdapter } from './loader-adapter.ts'
import { createProtectionPolicy } from './protect.ts'
import { registerMarketWebChannel } from './web-channel.ts'
import { NodeFs } from '../market/fs.ts'
import type {} from '../market/service.ts'

/** Stable plugin name; must not contain the loader-forbidden colon. */
export const name = 'plugin-market-control'

/** No static services: the repository arrives reactively via ctx.inject. */
export const inject: readonly string[] = []

/** User-facing Config of the control row (none today; future knobs land here). */
export interface Config {
  /** Removal confirmation validity window in milliseconds. */
  readonly confirmTtlMs?: number
}

/**
 * Activate the control service. Never rejects for an idle market: without a
 * marketRepository the row simply parks until one is configured.
 */
export function apply(ctx: Context, _config?: Config): void {
  const logger = ctx.logger(name)

  // One controller lifecycle per (marketRepository, loader) pairing. The
  // returned fiber belongs to this row's context, so unloading the row (or the
  // repository service vanishing) disposes the controller and its loader rows.
  void ctx.inject(['marketRepository', 'loader'], (marketCtx) => {
    const repository = marketCtx.marketRepository.repository
    const loaderAdapter = createLoaderAdapter(marketCtx.loader)
    const controller = new MarketPluginController({
      repositoryRoot: repository.root,
      records: repository.records,
      loader: loaderAdapter,
      removeDirectory: async (directory) => { await NodeFs.rmrf(directory) },
      protection: createProtectionPolicy(import.meta.url),
      entryModuleOf: (record) => entryModuleName(repository.root, record),
      entryDirectoryOf: (record) => entryDirectoryPath(repository.root, record),
      logger: {
        warn: (message) => { logger.warn(message) },
        error: (message) => { logger.error(message) },
      },
    })

    // Remote host surface: any dsh gateway composition routes these endpoints
    // through its live SRC discovery; no generated artifact is needed Host-side.
    const gateway = new MarketControllerGateway(marketCtx, controller)

    // Teardown owned by the inject fiber: when the repository service is
    // withdrawn or this row reloads, drop every loader row we created.
    let disposed = false
    marketCtx.effect(() => () => {
      disposed = true
      void controller.dispose()
    }, 'plugin-market-control: dispose controller')

    // Startup ordering: wait until the loader tree has no pending load or
    // lifecycle work (the include tree has settled), then rebuild records in
    // key order. Loader failures are per-record; the row itself never fails.
    void loaderAdapter.idle()
      .then(async () => {
        if (disposed) return
        await controller.rebuild()
      })
      .catch((error: unknown) => {
        logger.error(`market rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
      })

    // Optional same-origin web channel: registered only while a webServer
    // service is live (web composition); headless runs stay Remote-only.
    void marketCtx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        const dispose = registerMarketWebChannel(webCtx.webServer, gateway)
        return () => { dispose() }
      }, 'plugin-market-control: web channel')
    })
  })
}