/**
 * Production installer adapter of the market control surface: the one place
 * where the control layer's three-phase download decisions are handed to the
 * host pipeline and where the download facts come back.
 *
 * The adapter exists (instead of calling `PluginInstaller` inline at the
 * activation site) because this mapping is exactly what regressed once: a
 * host field the port must carry (the reviewed classification) is optional, so
 * dropping it is invisible to tsc and to the source-layer specs that substitute
 * the whole port. Keeping the mapping in one small, injectable function makes it
 * unit-testable with the host installer's own fake runner.
 *
 * Phase mapping (all phases belong to ONE installer instance, so the staging
 * registry — and therefore the handle — is the same for prepare/classify/commit
 * /cancel; the handle is process-local and never persisted):
 * - `prepare` → `PluginInstaller.prepareDownload` (clone only, no pnpm);
 * - `classify` → `PluginInstaller.classifyDownload` with the model endpoint the
 *   assembly configured (no endpoint → `unclassified` + `other`, never an
 *   error);
 * - `commit` → `PluginInstaller.commitDownload` (swap + record write, still no
 *   dependency install — `dependenciesInstalled` is always false);
 * - `cancel` → `PluginInstaller.cancelDownload` (staging cleanup, idempotent).
 */

import {
  PluginInstaller,
  isDownloadToken,
  type CommandRunner,
  type DownloadClassification,
  type DownloadToken,
} from '../market/install.ts'
import type { MarketRepository } from '../market/index.ts'
import type {
  CommittedDownloadFacts,
  DownloadClassifyOptions,
  DownloadHandle,
  DownloadPreparationClassify,
  InstallerPort,
  PreparedDownload,
  PrepareDownloadRequest,
  CommitDownloadRequest,
} from './source.ts'

/** Options of {@link createInstallerPort} (test seams; production passes none). */
export interface InstallerPortOptions {
  /** Subprocess runner override (defaults to the host pipeline's spawn runner). */
  readonly run?: CommandRunner
  /**
   * Model endpoint handed to the classification phase. Production wires it from
   * `Config.llm` (`complete` = the dsh LLM completion); without it the host
   * answers `unclassified` + `other` instead of throwing, so a market with no
   * model still downloads and files.
   */
  readonly classify?: DownloadClassifyOptions
}

/**
 * Build the installer port bound to one opened repository. The installer shares
 * the repository's records store instance, so there is exactly one serialized
 * writer per records file — and one staging registry per port, which is why the
 * control layer must reuse the port (not rebuild it) between the phases.
 */
export function createInstallerPort(
  repository: MarketRepository,
  options: InstallerPortOptions = {},
): InstallerPort {
  const installer = new PluginInstaller({
    store: repository.records,
    ...(options.run === undefined ? {} : { run: options.run }),
  })
  const classifyOptions = options.classify
  return {
    async prepare(input: PrepareDownloadRequest): Promise<PreparedDownload> {
      const staged = await installer.prepareDownload({
        repositoryRoot: input.repositoryRoot,
        key: input.key,
        ownerRepo: input.repository,
        // v2 ref downloads hand the host refKind + ref (the checkout lands at
        // the per-ref tuple target the key already encodes); legacy downloads
        // stay on the pre-v2 pin path with `version`. The source layer already
        // rejected null/empty refs for v2, so the `?? ''` guard is unreachable;
        // the host validates the ref defensively.
        ...(input.refKind === undefined
          ? { version: input.version ?? null }
          : { refKind: input.refKind, ref: input.version ?? '' }),
        confirmed: true,
      })
      return {
        token: staged.token,
        key: staged.key,
        repository: staged.repository,
        refKind: staged.refKind,
        ref: staged.ref,
        localDirName: staged.localDirName,
        commit: staged.commit,
        startedAt: staged.startedAt,
        state: staged.state,
      }
    },

    async classify(token: DownloadHandle): Promise<DownloadPreparationClassify> {
      const result = await installer.classifyDownload(asDownloadToken(token), classifyOptions)
      return toClassification(result)
    },

    async commit(input: CommitDownloadRequest): Promise<CommittedDownloadFacts> {
      const committed = await installer.commitDownload({
        token: asDownloadToken(input.token),
        classification: input.classification,
        ...(input.entry === undefined ? {} : { entry: input.entry }),
      })
      // No dependency install happens on the download path: the host reports
      // `dependenciesInstalled: false`, and the fact travels on verbatim so the
      // UI can show "dependencies not installed yet".
      return {
        record: committed.record,
        checkoutDir: committed.checkoutDir,
        classification: committed.classification,
        entry: committed.entry,
        dependenciesInstalled: committed.dependenciesInstalled,
        overwritten: committed.overwritten,
        note: committed.note,
      }
    },

    async cancel(token: DownloadHandle): Promise<boolean> {
      return await installer.cancelDownload(asDownloadToken(token))
    },
  }
}

/**
 * Hand the host its own handle type back. The token only ever comes from
 * `prepare` of this very port, so this is a shape assertion, not a user input
 * path: a malformed value still fails loudly rather than reaching the host
 * registry as a bare string.
 */
function asDownloadToken(token: DownloadHandle): DownloadToken {
  if (!isDownloadToken(token)) {
    throw new Error(`the control layer holds an invalid download handle: ${token}`)
  }
  return token
}

/** Map the host classification result onto the control channel shape. */
function toClassification(result: DownloadClassification): DownloadPreparationClassify {
  return {
    outcome: result.outcome,
    classification: result.classification,
    reason: result.reason,
    unclassified: result.unclassified,
    entryPresent: result.entryPresent,
    entryHint: result.entryHint,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  }
}
