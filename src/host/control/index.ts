/**
 * plugin-market-control — composable activation of the market control service.
 *
 * Activation contract (single-row convergence, M1 source ops):
 * - The control logic is NOT a standalone Loader row. The package main
 *   composer (`src/index.ts`) activates it inside the SAME context through
 *   `ctx.plugin(marketControlPlugin)`; `inject: ['loader']` parks the fiber
 *   until the root Loader resolves from that context chain.
 * - The gateway/web surface stays mounted even while the market is idle (no
 *   repository configured) and answers every repository-backed operation with
 *   the stable `market/idle` failure. Once the composer provides
 *   `marketRepository`, a nested `ctx.inject` builds the record-driven
 *   controller (loader-idle → rebuild in key order), and withdrawals tear the
 *   controller and its loader rows down.
 * - The webServer channel is registered only while a `webServer` service is
 *   live on the same chain (web composition); headless runs stay Remote-only.
 * - The control never manages loader entries outside the repository records
 *   and never removes or overwrites its own package rows or protected keys.
 *
 * Composers may use the exported {@link marketControlPlugin} object
 * (preferred; it carries the inject declaration) or call {@link apply}
 * directly when `ctx.loader` is already resolvable on the context chain.
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { MarketRepository } from '../market/index.ts'
import { GitHubMarket } from '../market/github.ts'
import { PluginPreviewer } from '../market/preview.ts'
import { PluginInstaller } from '../market/install.ts'
import { NodeFs } from '../market/fs.ts'
import { MarketPluginController } from './controller.ts'
import { entryDirectoryPath, entryModuleName } from './entry-name.ts'
import { MarketControllerGateway } from './gateway.ts'
import { createLoaderAdapter } from './loader-adapter.ts'
import { createProtectionPolicy } from './protect.ts'
import { MarketSourceOperations, type InstallerPort } from './source.ts'
import { registerMarketWebChannel } from './web-channel.ts'
import type {} from '../market/service.ts'

/** Stable plugin name; must not contain the loader-forbidden colon. */
export const name = 'plugin-market-control'

/**
 * Services the activation needs on the composing context chain: the root
 * Cordis Loader (the repository arrives reactively, if at all — the surface
 * stays mounted and answers `market/idle` while it is absent).
 */
export const inject: readonly string[] = ['loader']

/** User-facing Config of the control activation. */
export interface Config {
  /** Removal/install confirmation validity window in milliseconds. */
  readonly confirmTtlMs?: number
}

/** Live (repository, controller) pairing, or null while the market idles. */
type Runtime = {
  readonly repository: MarketRepository
  readonly controller: MarketPluginController
}

/**
 * Activate the market control service on `ctx`. Requires `ctx.loader` on the
 * context chain; the composer starts this regardless of whether a repository
 * is configured, so idle failures carry a friendly `market/idle` code.
 */
export function apply(ctx: Context, config?: Config): void {
  const logger = ctx.logger(name)
  const protection = createProtectionPolicy(import.meta.url)
  const ttl = config?.confirmTtlMs
  let runtime: Runtime | null = null

  // Source engines (search/detail/preview) are context-independent; the
  // installer is bound to the current repository per install so it shares the
  // records store instance (one serialized writer per records file).
  const github = new GitHubMarket()
  const source = new MarketSourceOperations({
    repository: () => runtime?.repository ?? null,
    searchEngine: github,
    detailEngine: github,
    previewEngine: new PluginPreviewer(),
    installer: (repository): InstallerPort => {
      const installer = new PluginInstaller({ store: repository.records })
      return {
        async install(input) {
          const outcome = await installer.install({
            repositoryRoot: input.repositoryRoot,
            key: input.key,
            ownerRepo: input.repository,
            // v2 ref installs hand the host refKind + ref (the checkout lands
            // at the per-ref tuple target the key already encodes); legacy
            // installs stay on the pre-v2 pin path with `version`. The source
            // layer already rejected null/empty refs for v2, so the `?? ''`
            // guard is unreachable; the host validates the ref defensively.
            ...(input.refKind === undefined
              ? { version: input.version ?? null }
              : { refKind: input.refKind, ref: input.version ?? '' }),
            confirmed: true,
          })
          return { record: outcome.record, checkoutDir: outcome.checkoutDir }
        },
      }
    },
    protection,
    syncRecord: async (record) => {
      await runtime?.controller.syncRecordRow(record)
    },
    ...(ttl === undefined ? {} : { confirmTtlMs: ttl }),
    logger: {
      warn: (message) => { logger.warn(message) },
      error: (message) => { logger.error(message) },
    },
  })

  // Remote host surface (always mounted; idle operations fail market/idle).
  const gateway = new MarketControllerGateway(ctx, {
    controller: () => runtime?.controller ?? null,
    repository: () => runtime?.repository ?? null,
    source,
  })

  // Record-driven controller lifecycle: (re)built whenever the composer
  // provides/withdraws the marketRepository service on this context chain.
  void ctx.inject(['marketRepository'], (repoCtx) => {
    const repository = repoCtx.marketRepository.repository
    const controller = new MarketPluginController({
      repositoryRoot: repository.root,
      records: repository.records,
      loader: createLoaderAdapter(repoCtx.loader),
      removeDirectory: async (directory) => { await NodeFs.rmrf(directory) },
      protection,
      entryModuleOf: (record) => entryModuleName(repository.root, record),
      entryDirectoryOf: (record) => entryDirectoryPath(repository.root, record),
      ...(ttl === undefined ? {} : { confirmTtlMs: ttl }),
      logger: {
        warn: (message) => { logger.warn(message) },
        error: (message) => { logger.error(message) },
      },
    })
    let disposed = false
    repoCtx.effect(() => () => {
      disposed = true
      if (runtime?.controller === controller) runtime = null
      void controller.dispose()
    }, 'plugin-market-control: dispose controller')
    runtime = { repository, controller }

    // Startup ordering: wait until the loader tree has no pending load or
    // lifecycle work (the include tree has settled), then rebuild records in
    // key order. Loader failures are per-record; this fiber never fails.
    void createLoaderAdapter(repoCtx.loader).idle()
      .then(async () => {
        if (disposed) return
        await controller.rebuild()
      })
      .catch((error: unknown) => {
        logger.error(`market rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  })

  // Optional same-origin web channel: registered only while a webServer
  // service is live on the same chain (web composition); headless stays
  // Remote-only. The nested inject fiber belongs to this fiber's context and
  // is torn down with it.
  void ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = registerMarketWebChannel(webCtx.webServer, gateway)
      return () => { dispose() }
    }, 'plugin-market-control: web channel')
  })
}

/**
 * Composable activation object for `ctx.plugin(...)`. Carries `name` and the
 * `inject` declaration, so the fiber resolves `loader` from the composer's
 * context chain before `apply` runs.
 */
export const marketControlPlugin = {
  name,
  inject,
  apply,
} satisfies Plugin.Object<Config>

export default marketControlPlugin
