import { MarketError } from './errors.ts'
import { NodeFs, type FsLike } from './fs.ts'
import { RepositoryDirectory } from './directory.ts'
import {
  createNodePackageResolver,
  SharedHarnessLinker,
  type HarnessEnsureResult,
  type HarnessPackageResolver,
  type HarnessVerifyResult,
  type SharedHarnessLinkerOptions,
} from './harness.ts'
import { repositoryRecordsPath, repositorySharedScopePath } from './layout.ts'
import { PluginRecordStore } from './records.ts'

/** Options for {@link openMarketRepository}. */
export interface OpenMarketRepositoryOptions {
  /** Injectable file-system adapter (defaults to {@link NodeFs}). */
  fs?: FsLike
  /** Injectable harness package resolver (defaults to the running instance). */
  resolver?: HarnessPackageResolver
  /** Create a missing root directory first (default false). */
  createIfMissing?: boolean
  /** Create/refresh the shared harness links (default true). */
  linkSharedHarness?: boolean
}

/** An opened, validated plugin source repository. */
export interface MarketRepository {
  /** Canonical absolute repository root. */
  readonly root: string
  /** Records store over `<root>/plugins.json`. */
  readonly records: PluginRecordStore
  /** Shared harness links present under `<root>/node_modules/@deepseek-ai`. */
  readonly harnessLinks: HarnessEnsureResult
  /**
   * Single-instance verification of the shared harness links; null when
   * `linkSharedHarness` was disabled.
   */
  readonly harnessVerified: HarnessVerifyResult | null
}

/**
 * Open a plugin source repository end to end:
 *
 * 1. validate the configured path (existence / directory / writability — each
 *    with its stable code and friendly message), optionally creating it;
 * 2. initialize the manager-owned layout (shared scope + pnpm conventions);
 * 3. load the records file (creating the v1 default on first use; a corrupted
 *    file fails loudly and is never overwritten);
 * 4. link the running instance's `@deepseek-ai/*` harness packages into the
 *    shared scope and verify the single-instance resolution.
 *
 * Throws {@link MarketError} with the stable {@link PluginMarketErrorCode}
 * vocabulary on any failure.
 */
export async function openMarketRepository(
  root: string,
  options: OpenMarketRepositoryOptions = {},
): Promise<MarketRepository> {
  const fs = options.fs ?? NodeFs
  const directory = new RepositoryDirectory(fs)
  let validation = await directory.validate(root)
  if (!validation.ok && validation.code === 'repository/not-exist' && options.createIfMissing === true) {
    await directory.create(root)
    validation = await directory.validate(root)
  }
  if (!validation.ok) {
    throw new MarketError(validation.code, validation.message, { path: validation.root })
  }
  await directory.ensureLayout(validation.root)

  const records = new PluginRecordStore(repositoryRecordsPath(validation.root), { fs })
  // First open creates the v1 default file; a corrupted file must fail here.
  await records.load()

  if (options.linkSharedHarness === false) {
    return {
      root: validation.root,
      records,
      harnessLinks: { scopePath: repositorySharedScopePath(validation.root), links: [] },
      harnessVerified: null,
    }
  }
  // exactOptionalPropertyTypes: never hand an explicit `undefined` resolver.
  const linkerOptions: SharedHarnessLinkerOptions = { fs }
  if (options.resolver !== undefined) linkerOptions.resolver = options.resolver
  const linker = new SharedHarnessLinker(linkerOptions)
  const harnessLinks = await linker.ensure(validation.root)
  const harnessVerified = await linker.verify(validation.root)
  return { root: validation.root, records, harnessLinks, harnessVerified }
}

export { createNodePackageResolver }

// --- Public reuse surface -------------------------------------------------
// Single import for the framework composer and consumer rows: the host entry
// (src/index.ts) is framework-owned and composes these exports instead of
// re-implementing activation. Behavior and stable error codes are unchanged.

export {
  normalizeMarketConfig,
  MARKET_CONFIG_DEFAULTS,
  requireMarketLlm,
  type Config,
  type MarketConfig,
  type MarketLlmConfig,
  type MarketLlmEndpoint,
  type ResolveEnvironment,
} from './config.ts'

export { MarketRepositoryService } from './service.ts'

export {
  GitHubMarket,
  githubFetch,
  envTokenProvider,
  defaultFetchLike,
  parseGitHubJson,
  parseRepositorySlug,
  isValidRepositorySlug,
  GITHUB_LIST_PAGE_SIZE,
  GITHUB_LIST_MAX_PAGES,
  type FetchLike,
  type FetchResponse,
  type TokenProvider,
  type GitHubMarketOptions,
  type GitHubSearchOptions,
  type GitHubRepoMeta,
  type GitHubResponseHeaders,
  type GitHubRequestOptions,
  SEARCH_EXCLUDED_REPOS,
} from './github.ts'

export {
  PluginPreviewer,
  type PluginPreviewerOptions,
} from './preview.ts'

export {
  DEFAULT_CHECKOUT_ENTRY,
  InMemoryDownloadStaging,
  PluginInstaller,
  installCheckoutDependencies,
  isDownloadToken,
  nodeCommandRunner,
  readCheckoutManifest,
  readCheckoutManifestState,
  resolveCheckoutEntry,
  resolveInstallTarget,
  type ClassifyDownloadOptions,
  type CommitDownloadInput,
  type CommittedDownload,
  type CommandOutcome,
  type CommandRunner,
  type DownloadClassification,
  type DownloadClassificationOutcome,
  type DownloadCompletion,
  type DownloadCompletionRequest,
  type DownloadStaging,
  type DownloadToken,
  type InstallPluginInput,
  type InstalledPlugin,
  type ManifestState,
  type PluginInstallerOptions,
  type PrepareDownloadInput,
  type RunOptions,
  type StagedDownload,
  type StagedDownloadState,
} from './install.ts'

export {
  parsePluginKey,
  isValidPluginKey,
  pluginKeyForGithubRef,
  PLUGIN_MARKET_KEY_MAX_LENGTH,
} from './keys.ts'

export {
  refSegOf,
  parseRefSeg,
  isManagedLocalDirName,
  splitManagedLocalDir,
  isLocalDirSegment,
  LOCAL_DIR_NAME_MAX_LENGTH,
  REF_SEG_MAX_LENGTH,
} from './paths.ts'

export {
  ANALYZE_SYSTEM_PROMPT,
  ANALYSIS_OUTPUT_MAX_LENGTH,
  ANALYSIS_REASON_MAX_LENGTH,
  PROMPT_MANIFEST_FIELD_MAX_CHARS,
  PROMPT_README_MAX_CHARS,
  README_CANDIDATES,
  SNAPSHOT_ENTRY_LIMIT,
  SNAPSHOT_EXCLUDED_TOP_LEVEL,
  InstallAnalyzer,
  buildAnalyzePrompt,
  collectCheckoutSnapshot,
  parseAnalysisOutput,
  probeCheckoutEntry,
  resolveAnalysisDistribution,
  resolveAnalysisVerdict,
  type AnalyzePrompt,
  type CheckoutEntryInfo,
  type CheckoutKind,
  type CheckoutManifestSummary,
  type CheckoutSnapshot,
  type CollectCheckoutSnapshotOptions,
  type InstallAnalyzerOptions,
  type LlmCompletion,
  type LlmCompletionRequest,
  type PluginAnalysisDistribution,
  type RawCheckoutAnalysis,
  type ResolveAnalysisOptions,
} from './analyze.ts'
