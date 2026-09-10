/**
 * Production installer adapter of the market control surface: the one place
 * where the control layer's review decisions are handed to the host install
 * pipeline and where the install-time facts come back.
 *
 * The adapter exists (instead of calling `PluginInstaller` inline at the
 * activation site) because the mapping is exactly what regressed once: the
 * reviewed `classification` is an OPTIONAL host field, so dropping it is
 * invisible to tsc and to the source-layer specs that substitute the whole
 * port. Keeping the mapping in one small, injectable function makes it
 * unit-testable with the host installer's own fake runner.
 *
 * `repositoryRoot`/`key`/`repository`/`version`/`refKind` are positional data
 * the caller already validated; the classification is a hint only — the host
 * probes the real checkout entry first and files a runnable entry as `plugin`
 * regardless of it.
 */

import { PluginInstaller, type CommandRunner } from '../market/install.ts'
import type { MarketRepository } from '../market/index.ts'
import type { InstallerPort } from './source.ts'

/** Options of {@link createInstallerPort} (test seams; production passes none). */
export interface InstallerPortOptions {
  /** Subprocess runner override (defaults to the host pipeline's spawn runner). */
  readonly run?: CommandRunner
}

/**
 * Build the installer port bound to one opened repository. The installer shares
 * the repository's records store instance, so there is exactly one serialized
 * writer per records file.
 */
export function createInstallerPort(
  repository: MarketRepository,
  options: InstallerPortOptions = {},
): InstallerPort {
  const installer = new PluginInstaller({
    store: repository.records,
    ...(options.run === undefined ? {} : { run: options.run }),
  })
  return {
    async install(input) {
      const outcome = await installer.install({
        repositoryRoot: input.repositoryRoot,
        key: input.key,
        ownerRepo: input.repository,
        // v2 ref installs hand the host refKind + ref (the checkout lands at
        // the per-ref tuple target the key already encodes); legacy installs
        // stay on the pre-v2 pin path with `version`. The source layer already
        // rejected null/empty refs for v2, so the `?? ''` guard is
        // unreachable; the host validates the ref defensively.
        ...(input.refKind === undefined
          ? { version: input.version ?? null }
          : { refKind: input.refKind, ref: input.version ?? '' }),
        // The reviewed classification rides into the host pipeline, which
        // probes the real entry first: a runnable entry always wins (filed
        // `plugin`), and the hint only decides `skills` vs `other` for an
        // entry-less checkout. Omitting it would silently drop the reviewed tag.
        ...(input.classification === undefined ? {} : { classification: input.classification }),
        confirmed: true,
      })
      // Report the install-time facts back verbatim, so a consumer sees what
      // was really filed (not what the review predicted). `entryNote` is the
      // host pipeline's own diagnostic prose: it is forwarded for
      // logs/tests only and consumers must not render it as user-visible copy
      // (see PluginInstallOutcome; UI copy comes from classification/entry and
      // from the review's structured note).
      return {
        record: outcome.record,
        checkoutDir: outcome.checkoutDir,
        classification: outcome.classification,
        entry: outcome.entry,
        entryNote: outcome.entryNote,
        dependenciesInstalled: outcome.dependenciesInstalled,
      }
    },
  }
}
