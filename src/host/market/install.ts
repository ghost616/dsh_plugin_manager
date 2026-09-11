/**
 * Plugin download pipeline (three separately callable phases) + the legacy
 * one-shot installer.
 *
 * ## Three-phase download (the contract control/UI consume)
 *
 * 1. {@link PluginInstaller.prepareDownload} — clone into a private staging
 *    directory and return a {@link StagedDownload} handle. **No classification,
 *    no dependency install, no record write yet**; everything is revocable via
 *    {@link PluginInstaller.cancelDownload}.
 * 2. {@link PluginInstaller.classifyDownload} — classify the staged checkout
 *    (`plugin` | `skills` | `other`). The classification is **always** the
 *    model's call: the mechanical entry probe is only a *hint* passed into the
 *    prompt (`entryPresent`/`entryHint`), never a classification by itself —
 *    that is what used to mis-file skills packs as plugins. A model that is
 *    unavailable or fails never blocks the download: the result is
 *    `outcome: 'unclassified' | 'failed'` and the caller files `other` with the
 *    reason, so the user can correct it later
 *    ({@link PluginRecordStore.setClassification}).
 * 3. {@link PluginInstaller.commitDownload} — atomically move the staged
 *    checkout to its final `<root>/<owner>/<repo>/<kind>/<refSeg>` location and
 *    write the record (`enabled: false`, TrustGate `trusted`).
 *
 * ## Dependencies are NOT part of the download path
 *
 * `pnpm install` is not run by any download phase. It lives on as the
 * standalone {@link installCheckoutDependencies} for a later, explicit
 * "install dependencies" action; downloads always record
 * `dependenciesInstalled: false` (the phase facts on {@link CommittedDownload}).
 *
 * ## Legacy one-shot install
 *
 * {@link PluginInstaller.install} keeps the pre-refactor behavior (single call,
 * entry-probe classification, best-effort dependency step) for callers written
 * against it. New callers use the three phases; the legacy method is scheduled
 * for removal once the control surface is migrated.
 *
 * ## Directory conventions
 *
 * - v2 ref installs (`refKind` + `ref` supplied) target the multi-level
 *   `<root>/<owner>/<repo>/<branch|tag>/<refSeg>` and register a
 *   per-`(owner, repo, ref-kind, ref)` key with a source carrying `refKind`;
 *   distinct refs of the same repository coexist, and reinstalling the same
 *   tuple is an overwrite update of its own checkout.
 * - legacy installs (no `refKind`) keep the pre-v2 behavior: checkout under a
 *   caller-provided single-level `localDirName` (defaulting to the key).
 *
 * Staging keeps every failure recoverable: a phase that throws leaves the
 * staged directory removable through the handle, and the final swap only
 * happens after the new checkout is complete.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  GithubRefKind,
  PluginMarketClassification,
  PluginMarketKey,
  PluginMarketRecord,
} from '../../types.ts'
import {
  MarketError,
  marketError,
  type MarketErrorOptions,
} from './errors.ts'
import { NodeFs, type FsLike } from './fs.ts'
import { parseRepositorySlug } from './github.ts'
import { isValidPluginKey, pluginKeyForGithubRef } from './keys.ts'
import { RepositoryDirectory } from './directory.ts'
import { repositoryRecordsPath } from './layout.ts'
import {
  isCheckoutEntryPath,
  isLocalDirSegment,
  normalizeCheckoutEntry,
  refSegOf,
} from './paths.ts'
import { PluginRecordStore } from './records.ts'
import {
  buildAnalyzePrompt,
  collectCheckoutSnapshot,
  parseAnalysisOutput,
  probeCheckoutEntry,
  resolveAnalysisDistribution,
  type CheckoutManifestSummary,
  type CheckoutSnapshot,
} from './analyze.ts'

/** Conventional plugin entry used when the manifest resolves none. */
export const DEFAULT_CHECKOUT_ENTRY = 'index.js'

/** Options of one external command invocation. */
export interface RunOptions {
  readonly cwd?: string
  readonly env?: Record<string, string>
}

/** Captured result of one external command. */
export interface CommandOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Injectable subprocess runner (git/pnpm), replaced by tests. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<CommandOutcome>

/** Default runner: node child_process spawn with captured output. */
export const nodeCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    const errorChunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => errorChunks.push(chunk))
    child.on('error', (error) => resolve({
      code: -1,
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr: String(error?.message ?? error),
    }))
    child.on('close', (code) => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr: Buffer.concat(errorChunks).toString('utf8'),
    }))
  })

/**
 * Input of {@link PluginInstaller.install} — the **legacy one-shot install**
 * surface (see that method: no in-package caller; use the three download phases
 * for new code).
 */
export interface InstallPluginInput {
  /** Validated repository root (must already exist and be writable). */
  readonly repositoryRoot: string
  /**
   * Stable loader-safe key. For v2 ref installs it must equal
   * `pluginKeyForGithubRef(ownerRepo, refKind, ref)`; legacy installs keep
   * using the caller-provided key (e.g. `gh-owner-repo`).
   */
  readonly key: PluginMarketKey
  /** `owner/repo` slug to clone. */
  readonly ownerRepo: string
  /** v2 ref kind; when set the checkout lands at the multi-level ref target. */
  readonly refKind?: 'branch' | 'tag'
  /** Branch/tag name to clone (required together with `refKind`). */
  readonly ref?: string
  /** Optional tag/branch pin (legacy alias of `ref`, pre-v2 callers). */
  readonly version?: string | null
  /** Optional commit override; the cloned HEAD sha is recorded otherwise. */
  readonly commit?: string | null
  /**
   * Checkout location under the repository root. Legacy installs default it
   * to the key; v2 ref installs derive it from the ref tuple.
   */
  readonly localDirName?: string
  /**
   * Explicit entry override; otherwise resolved from the manifest. Must
   * already be a normalized checkout-relative path (forward-slash segments, no
   * leading `./`, no escaping `..`) — unlike the third-party manifest
   * `main`/`exports` values it is NOT normalized, and an invalid value fails
   * fast with `record/invalid` before any side effect.
   */
  readonly entry?: string
  /**
   * Classification hint used only when the checkout has NO runnable entry:
   * the entry probe wins, so a checkout carrying a resolvable, present entry is
   * always classified `plugin` regardless of this value. Without a runnable
   * entry the hint narrows the outcome to `'skills'`; any other value (or
   * omitting it) files the checkout as `'other'`. Because the resolved
   * classification gates the dependency step, a hint that survives (i.e. the
   * checkout really has no entry) also means `pnpm install` is skipped.
   */
  readonly classification?: PluginMarketClassification
  /** TrustGate consent — false refuses the install before any side effect. */
  readonly confirmed: boolean
  /** Shallow clone depth (default 1; 0 = full clone). */
  readonly depth?: number
}

/**
 * Result of the **legacy one-shot install** ({@link PluginInstaller.install};
 * see that method for why it is kept):
 *
 * `classification` mirrors `record.classification`; `entry` is the runnable
 * entry that was registered, or null when the checkout has none (the record then
 * carries `entry: null` and the control layer decides whether a loader row is
 * registered at all). `entryNote` is a DEBUG/LOG-ONLY diagnostic string (never
 * user-facing copy); `dependenciesInstalled` is **always false** on this path —
 * no package manager runs during a download (the dependency step is the
 * standalone `installCheckoutDependencies`).
 */
export interface InstalledPlugin {
  readonly record: PluginMarketRecord
  readonly checkoutDir: string
  readonly classification: PluginMarketClassification
  readonly entry: string | null
  readonly entryNote: string | null
  /** Always false: downloads never install dependencies. */
  readonly dependenciesInstalled: boolean
}

/**
 * Attach the swap fact to a commit failure so callers can tell the two failure
 * windows apart (see {@link PluginInstaller.commitDownload}):
 * `details.swapCompleted = false` means the checkout never moved (staging was
 * cleaned, the previous checkout/record are intact), `true` means the new
 * checkout is already in place and only the record write failed — the checkout
 * is kept for manual repair and the record still holds its previous value.
 */
function withSwapFact(error: MarketError, swapCompleted: boolean, checkoutDir: string): MarketError {
  const details = { ...error.details, swapCompleted, checkoutDir }
  const note = swapCompleted
    ? ' The new checkout is already in place; the record could not be updated, so it still holds its previous value — repair the record or re-commit.'
    : ' The staged checkout was removed; the previous checkout and record (if any) are unchanged.'
  const next = new MarketError(error.code, `${error.message}${note}`, { details })
  next.cause = error
  return next
}

/** String field of a raw manifest object, or null. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Whether a manifest's `scripts` object declares a non-blank `build` script. */
function hasNonEmptyBuildScript(scripts: unknown): boolean {
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return false
  const build = (scripts as Record<string, unknown>)['build']
  return typeof build === 'string' && build.trim().length > 0
}

/** Options for {@link PluginInstaller}.
 *
 * The three-phase API additionally registers its staged downloads in an
 * injectable {@link DownloadStaging} so cancellation can be reasoned about and
 * tested independently of the class instance.
 */
export interface PluginInstallerOptions {
  readonly fs?: FsLike
  readonly run?: CommandRunner
  /** Records store; defaults to `<root>/plugins.json` over the same fs. */
  readonly store?: PluginRecordStore
  /** Staged-download registry (defaults to a private per-installer one). */
  readonly staging?: DownloadStaging
}

/* ------------------------------------------------------------------------ */
/* Three-phase download contract                                            */
/* ------------------------------------------------------------------------ */

/** Runtime brand of a staged-download token (never a bare string cross-layer). */
declare const downloadTokenBrand: unique symbol

/**
 * Opaque, process-local handle of one staged download. It is **not** a
 * filename or a path: consumers (control/UI) pass it back verbatim to
 * {@link PluginInstaller.classifyDownload} /
 * {@link PluginInstaller.commitDownload} /
 * {@link PluginInstaller.cancelDownload}.
 */
export type DownloadToken = string & { readonly [downloadTokenBrand]: 'download-token' }

/**
 * Validate/narrow an untrusted value into a {@link DownloadToken}: the exact
 * shape this host mints (`dl-` + 32 lowercase hex chars from
 * `crypto.randomBytes(16)`). Anything else is refused, so a caller cannot pass
 * an arbitrary string into the phase methods.
 */
export function isDownloadToken(value: unknown): value is DownloadToken {
  return typeof value === 'string' && /^dl-[0-9a-f]{32}$/.test(value)
}

/** Lifecycle state of one staged download. */
export type StagedDownloadState =
  /** Cloned and awaiting classification/commit; cancellation is allowed. */
  | 'prepared'
  /** Classified (the label is not stored on the host — the caller keeps it). */
  | 'classified'
  /** Swap + record write finished; the handle is consumed. */
  | 'committed'

/**
 * The handle returned by {@link PluginInstaller.prepareDownload}: everything the
 * later phases and the UI need, and nothing secret.
 *
 * **Lifetime**: process-local and in-memory only — the token is valid for the
 * lifetime of the `PluginInstaller` instance that minted it (and of the process
 * that owns it). It is deliberately NOT persisted and cannot be replayed after
 * a restart: a restart leaves the staging directory behind and the next
 * `prepareDownload` cleans stale staging roots. Consumers must therefore keep
 * the handle in memory (control: per pending install; UI: the in-flight dialog
 * state, dropped on cancel/unmount).
 */
export interface StagedDownload {
  /** Opaque handle token forwarded to the later phases. */
  readonly token: DownloadToken
  /** Stable loader-safe key the eventual record will carry. */
  readonly key: PluginMarketKey
  /** `owner/repo` slug that was cloned. */
  readonly repository: string
  /** v2 ref kind, or undefined for a legacy default-branch download. */
  readonly refKind: GithubRefKind | undefined
  /** Branch/tag name that was checked out (null for a legacy unpinned clone). */
  readonly ref: string | null
  /** Absolute staging directory (private to the download). */
  readonly stagedDir: string
  /** Absolute final checkout directory the commit phase will create. */
  readonly checkoutDir: string
  /** Repository-root-relative checkout location the record will carry. */
  readonly localDirName: string
  /** Commit the staged checkout sits at, when resolvable. */
  readonly commit: string | null
  /** ISO-8601 timestamp of the staging start. */
  readonly startedAt: string
  /** Current lifecycle state (see {@link StagedDownloadState}). */
  readonly state: StagedDownloadState
}

/** How one download attempt finished, for UI progress/notes. */
export type DownloadClassificationOutcome =
  /** The model classified the checkout. */
  | 'classified'
  /** The model was unavailable (no endpoint / no backend) — filed as `other`. */
  | 'unclassified'
  /** The model call itself failed — filed as `other`, retryable. */
  | 'failed'

/**
 * Result of {@link PluginInstaller.classifyDownload}. **This phase never
 * throws**: a model that is missing or fails yields
 * `outcome: 'unclassified' | 'failed'` with `classification: 'other'` and a
 * human-readable `reason`, so the download keeps its checkout and the user can
 * correct the label later.
 */
export interface DownloadClassification {
  readonly outcome: DownloadClassificationOutcome
  /** Label to commit: the model's answer, or the conservative `'other'`. */
  readonly classification: PluginMarketClassification
  /** User-facing rationale (model reason, or why no classification happened). */
  readonly reason: string
  /** True when the model could not classify (either `unclassified` or `failed`). */
  readonly unclassified: boolean
  /**
   * Mechanical hint only (never the classifier): whether the resolved entry
   * exists in the checkout. `null` when the checkout has no usable manifest.
   */
  readonly entryPresent: boolean | null
  /** Entry the mechanical probe resolved (checkout-relative), or null. */
  readonly entryHint: string | null
  /** Stable error code of a failed model call (`market/llm-*`, `market/io`). */
  readonly errorCode?: string
}

/** Input of {@link PluginInstaller.commitDownload}. */
export interface CommitDownloadInput {
  /** Handle from {@link PluginInstaller.prepareDownload}. */
  readonly token: DownloadToken
  /** Label to file (from {@link PluginInstaller.classifyDownload}). */
  readonly classification: PluginMarketClassification
  /**
   * Runnable entry to register, or null for an entry-less checkout. Defaults to
   * the mechanically resolved entry of the staged checkout (a hint that only
   * decides whether a loader row is possible).
   */
  readonly entry?: string | null
  /** Optional note recorded for the caller (diagnostics only). */
  readonly note?: string
}

/** Facts of one committed download (see {@link InstalledPlugin} for the legacy shape). */
export interface CommittedDownload {
  readonly record: PluginMarketRecord
  /** Final absolute checkout directory. */
  readonly checkoutDir: string
  readonly classification: PluginMarketClassification
  /** Registered runnable entry, or null for an entry-less checkout. */
  readonly entry: string | null
  /**
   * Always `false`: the download path never installs dependencies. The fact is
   * kept so control/UI can show "dependencies not installed yet" and a later
   * explicit action can flip it.
   */
  readonly dependenciesInstalled: false
  /** Whether an existing checkout for the same key was replaced. */
  readonly overwritten: boolean
  /** Diagnostic note (null on the happy path). */
  readonly note: string | null
}

/**
 * Registry of staged downloads. Injectable so cancellation and lifecycle can be
 * tested without the class, and so an assembly could share one registry across
 * installer instances.
 *
 * `add` REFUSES to silently replace an entry: two live downloads must never
 * share one handle (a silent overwrite would orphan the first checkout and make
 * cancellation delete the wrong one), so a duplicate token throws
 * `install/io` and the caller mints another one.
 */
export interface DownloadStaging {
  /** Register a freshly staged download and return its handle. */
  add(entry: StagedDownload): StagedDownload
  /** Look one up by token (null when unknown/expired). */
  get(token: DownloadToken): StagedDownload | null
  /** Transition the state of a known handle (no-op when unknown). */
  mark(token: DownloadToken, state: StagedDownloadState): void
  /** Forget one handle (called after commit/cancel). */
  remove(token: DownloadToken): void
  /** All currently registered handles (stable order). */
  list(): readonly StagedDownload[]
}

/** In-memory {@link DownloadStaging} used by default. */
export class InMemoryDownloadStaging implements DownloadStaging {
  private readonly entries = new Map<DownloadToken, StagedDownload>()

  /**
   * Register one staged download. A token that is still live is **rejected**
   * (`install/io`) instead of being overwritten: the handle identifies a
   * staging directory, so a silent replace would leak the first checkout and
   * let {@link PluginInstaller.cancelDownload} remove the wrong one. Callers
   * mint a fresh token and retry (see `PluginInstaller.mintUnusedToken`).
   */
  add(entry: StagedDownload): StagedDownload {
    if (this.entries.has(entry.token)) {
      throw new MarketError(
        'install/io',
        `The download handle "${entry.token}" is already in use; refusing to replace a live download.`,
        { path: entry.stagedDir, details: { token: entry.token } },
      )
    }
    this.entries.set(entry.token, entry)
    return entry
  }

  get(token: DownloadToken): StagedDownload | null {
    return this.entries.get(token) ?? null
  }

  mark(token: DownloadToken, state: StagedDownloadState): void {
    const current = this.entries.get(token)
    if (current === undefined) return
    this.entries.set(token, { ...current, state })
  }

  remove(token: DownloadToken): void {
    this.entries.delete(token)
  }

  list(): readonly StagedDownload[] {
    return [...this.entries.values()]
  }
}

/** Input of {@link PluginInstaller.prepareDownload} (the download half of an install). */
export interface PrepareDownloadInput {
  /** Validated repository root (must already exist and be writable). */
  readonly repositoryRoot: string
  /**
   * Stable loader-safe key. For v2 ref downloads it must equal
   * `pluginKeyForGithubRef(ownerRepo, refKind, ref)`; legacy downloads keep
   * using the caller-provided key (e.g. `gh-owner-repo`).
   */
  readonly key: PluginMarketKey
  /** `owner/repo` slug to clone. */
  readonly ownerRepo: string
  /** v2 ref kind; when set the checkout lands at the multi-level ref target. */
  readonly refKind?: GithubRefKind
  /** Branch/tag name to clone (required together with `refKind`). */
  readonly ref?: string
  /** Optional tag/branch pin (legacy alias of `ref`, pre-v2 callers). */
  readonly version?: string | null
  /** Checkout location under the repository root (legacy downloads). */
  readonly localDirName?: string
  /** TrustGate consent — false refuses the download before any side effect. */
  readonly confirmed: boolean
  /** Shallow clone depth (default 1; 0 = full clone). */
  readonly depth?: number
}

/** Options of {@link PluginInstaller.classifyDownload}. */
export interface ClassifyDownloadOptions {
  /**
   * Completion backend (from `Config.llm` at the assembly layer). Absent/undefined
   * means no endpoint is configured: the result is `unclassified` → `other`.
   *
   * Structurally identical to `analyze.ts`'s `LlmCompletion`; redeclared here so
   * the download pipeline does not have to import the analyzer module.
   */
  readonly complete?: DownloadCompletion
  /** LLM provider id (from `Config.llm`). */
  readonly provider?: string
  /** LLM model id (from `Config.llm`). */
  readonly model?: string
}

/** One completion invocation the classifier performs. */
export interface DownloadCompletionRequest {
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly user: string
}

/** Completion backend injected by the control/assembly layer. */
export type DownloadCompletion = (request: DownloadCompletionRequest) => Promise<string>

/**
 * The download/install pipeline. Git/pnpm/fs are injectable; the pipeline
 * never touches the network itself.
 */
export class PluginInstaller {
  private readonly fs: FsLike
  private readonly run: CommandRunner
  private readonly store: PluginRecordStore | undefined
  private readonly staging: DownloadStaging
  private nextTokenId = 0

  constructor(options: PluginInstallerOptions = {}) {
    this.fs = options.fs ?? NodeFs
    this.run = options.run ?? nodeCommandRunner
    this.store = options.store
    this.staging = options.staging ?? new InMemoryDownloadStaging()
  }

  /* ---------------------------------------------------------------------- */
  /* Three-phase download                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Phase 1 — clone the checkout into a private staging directory.
   *
   * No classification, no dependency install and no record write happen here;
   * the returned {@link StagedDownload} is the only handle needed by the later
   * phases and by cancellation.
   *
   * @throws {MarketError} `gate/consent-required` (not confirmed, zero side
   * effect), `record/key-invalid`, `record/invalid`, `github/bad-request`
   * (slug), `install/dir-exists` / `install/dir-in-use` (target occupied),
   * `install/git-failed` (clone), `install/io` (unexpected).
   */
  async prepareDownload(input: PrepareDownloadInput): Promise<StagedDownload> {
    const root = input.repositoryRoot
    if (!input.confirmed) {
      throw new MarketError(
        'gate/consent-required',
        'Downloading a plugin requires an explicit TrustGate confirmation; nothing was downloaded or written.',
        { path: root },
      )
    }
    const ownerRepo = parseRepositorySlug(input.ownerRepo)
    if (!isValidPluginKey(input.key)) {
      throw new MarketError('record/key-invalid', `"${input.key}" is not a valid stable plugin-market key.`)
    }
    const target = resolveInstallTarget(ownerRepo, input)
    await new RepositoryDirectory(this.fs).ensureLayout(root)
    const store = this.storeFor(root)
    await this.assertTargetFree(store, target.key, target.dirName, root)
    await this.removeStaleStaging(root)

    const finalDir = join(root, ...target.dirName.split('/'))
    const stagedDir = join(root, `.staged-${target.key}-${process.pid}-${this.nextTokenId++}`)
    try {
      await this.cloneSource(ownerRepo, stagedDir, {
        depth: input.depth ?? 1,
        refKind: target.refKind,
        ref: target.refName,
      })
      const commit = await this.readHeadSha(stagedDir)
      const handle: StagedDownload = {
        token: this.mintUnusedToken(),
        key: target.key,
        repository: ownerRepo,
        refKind: target.refKind,
        ref: target.refName,
        stagedDir,
        checkoutDir: finalDir,
        localDirName: target.dirName,
        commit,
        startedAt: new Date().toISOString(),
        state: 'prepared',
      }
      return this.staging.add(handle)
    } catch (error) {
      await this.fs.rmrf(stagedDir).catch(() => undefined)
      if (error instanceof MarketError) throw error
      throw new MarketError('install/io', 'The plugin download failed unexpectedly.', { path: root, cause: error })
    }
  }

  /**
   * Phase 2 — classify the staged checkout. **Never throws** (see
   * {@link DownloadClassification}): the model decides `plugin`/`skills`/
   * `other`, and every model problem degrades to `other` + reason, so the
   * download is never blocked by an unavailable model.
   *
   * The mechanical entry probe runs first but is only passed to the model as a
   * hint — it never classifies on its own.
   */
  async classifyDownload(
    token: DownloadToken,
    options: ClassifyDownloadOptions = {},
  ): Promise<DownloadClassification> {
    const staged = this.requireStaged(token)
    const snapshot = await this.snapshotForClassification(staged.stagedDir)
    const mechanical = snapshot.entryPresent
    const complete = options.complete
    if (complete === undefined) {
      return {
        outcome: 'unclassified',
        // Skills/capability packs carry an index.js often enough that the old
        // mechanical probe filed them as plugins; without a model verdict the
        // honest tag is the conservative one.
        classification: 'other',
        reason: 'No smart-install model is configured, so the checkout could not be classified; it was filed as "other" and can be corrected manually.',
        unclassified: true,
        entryPresent: mechanical,
        entryHint: snapshot.entryHint,
      }
    }
    try {
      const raw = await this.runCompletion(complete, options, snapshot.snapshot)
      const entryPresent = await this.probeEntry(
        staged.stagedDir,
        snapshot.entryHint ?? DEFAULT_CHECKOUT_ENTRY,
      )
      const distribution = resolveAnalysisDistribution(raw, entryPresent === undefined ? {} : { entryPresent })
      this.staging.mark(token, 'classified')
      return {
        outcome: 'classified',
        classification: distribution.classification,
        reason: distribution.reason,
        unclassified: false,
        entryPresent: entryPresent ?? snapshot.entryPresent,
        entryHint: distribution.entryHint ?? snapshot.entryHint,
      }
    } catch (error) {
      const code = error instanceof MarketError ? error.code : 'market/llm-failed'
      const message = error instanceof Error ? error.message : String(error)
      const unavailable = code === 'market/llm-unconfigured'
      return {
        outcome: unavailable ? 'unclassified' : 'failed',
        classification: 'other',
        reason: unavailable
          ? 'The smart-install model is not configured for this market, so the checkout was filed as "other"; configure Config.llm and re-classify, or set the classification manually.'
          : `Smart-install classification failed (${code}), so the checkout was filed as "other"; retry classification or set it manually. ${message}`.trim(),
        unclassified: true,
        entryPresent: mechanical,
        entryHint: snapshot.entryHint,
        errorCode: code,
      }
    }
  }

  /**
   * Phase 3 — atomically move the staged checkout to its final location and
   * register the record (TrustGate `trusted`, `enabled: false`).
   *
   * **Failure semantics (the swap fact is observable).** The commit has two
   * windows and they are NOT equivalent:
   *
   * - **before the swap** (`swapCompleted === false`): the rename has not run,
   *   so the staging directory is still there and is removed — zero residue —
   *   and any previous checkout/record for the same key is untouched.
   * - **after the swap** (`swapCompleted === true`): the rename already moved the
   *   checkout to its final location, so the staging directory no longer exists
   *   and is NOT cleaned; the new checkout is deliberately **kept in place** so
   *   the failure can be repaired by hand (the caller sees this through
   *   `error.details['swapCompleted']`, which `MarketError` also copies onto the
   *   instance for direct reading). The record still holds its previous value in
   *   that case — the checkout is newer than the record, and the error says so
   *   instead of pretending the two agree.
   *
   * @throws {MarketError} `record/not-found` for an unknown/expired token,
   * `record/invalid` for an invalid entry path, and `install/io` for swap or
   * record-write failures (carrying `details.swapCompleted`).
   */
  async commitDownload(input: CommitDownloadInput): Promise<CommittedDownload> {
    const staged = this.requireStaged(input.token)
    const store = this.storeFor(join(staged.stagedDir, '..'))
    const existing = await store.get(staged.key)
    const overwritten = existing !== null
    const entry = input.entry === undefined
      ? await this.resolveStagedEntry(staged.stagedDir)
      : input.entry
    if (entry !== null && !isCheckoutEntryPath(entry)) {
      throw new MarketError('record/invalid', `entry "${entry}" is not a valid checkout-relative entry path.`)
    }
    // Local marker of the swap window: set exactly once the rename succeeded.
    let swapCompleted = false
    try {
      await this.fs.mkdirp(dirname(staged.checkoutDir))
      if ((await this.fs.lstat(staged.checkoutDir)) !== null) await this.fs.rmrf(staged.checkoutDir)
      await this.fs.rename(staged.stagedDir, staged.checkoutDir)
      swapCompleted = true
      const record = await store.register({
        key: staged.key,
        source: staged.refKind === undefined
          ? { kind: 'github', repository: staged.repository, version: staged.ref, commit: staged.commit }
          : { kind: 'github', refKind: staged.refKind, repository: staged.repository, version: staged.ref ?? '', commit: staged.commit },
        localDirName: this.localDirNameOf(staged),
        ...(entry === null ? {} : { entry }),
        classification: entry === null && input.classification === 'plugin' ? 'other' : input.classification,
      }, { trusted: true })
      const previous = existing !== null && existing.localDirName !== record.localDirName
        ? join(dirname(staged.checkoutDir), ...existing.localDirName.split('/'))
        : null
      this.staging.mark(input.token, 'committed')
      this.staging.remove(input.token)
      if (previous !== null && previous !== staged.checkoutDir) {
        await this.fs.rmrf(previous).catch(() => undefined)
      }
      return {
        record,
        checkoutDir: staged.checkoutDir,
        classification: record.classification ?? 'plugin',
        entry: record.entry,
        dependenciesInstalled: false,
        overwritten,
        note: input.note ?? null,
      }
    } catch (error) {
      this.staging.remove(input.token)
      if (!swapCompleted) {
        // Pre-swap failure: the staged clone is still on disk and is garbage.
        await this.fs.rmrf(staged.stagedDir).catch(() => undefined)
      }
      if (error instanceof MarketError) throw withSwapFact(error, swapCompleted, staged.checkoutDir)
      throw withSwapFact(
        new MarketError('install/io', 'Committing the downloaded checkout failed.', { path: staged.checkoutDir, cause: error }),
        swapCompleted,
        staged.checkoutDir,
      )
    }
  }

  /**
   * Cancel a staged download: remove the staging directory (zero residue) and
   * drop the handle. Idempotent — cancelling an unknown/already-consumed token
   * resolves to `false` without touching the filesystem. A committed download
   * can no longer be cancelled (its checkout is live): that also resolves
   * `false`.
   */
  async cancelDownload(token: DownloadToken): Promise<boolean> {
    const staged = this.staging.get(token)
    if (staged === null || staged.state === 'committed') return false
    await this.fs.rmrf(staged.stagedDir).catch(() => undefined)
    this.staging.remove(token)
    return true
  }

  /** All staged downloads of this installer (for UI progress/cleanup). */
  stagedDownloads(): readonly StagedDownload[] {
    return this.staging.list()
  }

  /* ---------------------------------------------------------------------- */
  /* Three-phase helpers                                                    */
  /* ---------------------------------------------------------------------- */

  private storeFor(root: string): PluginRecordStore {
    return this.store ?? new PluginRecordStore(repositoryRecordsPath(root), { fs: this.fs })
  }

  /**
   * Mint one opaque download token from a cryptographically random source
   * (`crypto.randomBytes`, 16 bytes hex) so tokens cannot be guessed or collide
   * by accident the way a `Math.random`/timestamp scheme can.
   */
  private mintToken(): DownloadToken {
    return `dl-${randomBytes(16).toString('hex')}` as DownloadToken
  }

  /** Mint a token that is not in use yet (bounded retry; collision is fatal). */
  private mintUnusedToken(): DownloadToken {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = this.mintToken()
      if (this.staging.get(token) === null) return token
    }
    throw new MarketError(
      'install/io',
      'Could not allocate a unique download handle (token collision); retry the download.',
    )
  }

  private requireStaged(token: DownloadToken): StagedDownload {
    const staged = isDownloadToken(token) ? this.staging.get(token) : null
    if (staged === null) {
      // `record/not-found` is the vocabulary's "the thing you referenced does
      // not exist" code; the control layer maps it onto its own channel error
      // for an expired download handle.
      throw new MarketError(
        'record/not-found',
        'This download handle is unknown or has expired; start the download again.',
      )
    }
    return staged
  }

  /**
   * Local dir name of one staged handle: the target the commit phase will use,
   * already computed by `prepareDownload` (never re-derived from paths).
   */
  private localDirNameOf(staged: StagedDownload): string {
    return staged.localDirName
  }

  /**
   * Remove staging roots from earlier runs (a crash or restart leaves them
   * behind; the token registry is in-memory only). Best effort: never fails the
   * download.
   */
  private async removeStaleStaging(root: string): Promise<void> {
    try {
      const entries = await this.fs.readdir(root)
      for (const name of entries) {
        if (name.startsWith('.staged-')) await this.fs.rmrf(join(root, name)).catch(() => undefined)
      }
    } catch {
      // The root was validated by the caller; a readdir failure is not fatal.
    }
  }

  /**
   * Mechanical snapshot of a staged checkout, built from the checkout's **real
   * manifest** (the same tolerant read + entry resolution the commit phase
   * uses), so the prompt the model sees and the entry that finally lands in the
   * record can never disagree — `package.json` `exports` included.
   *
   * The entry result is only a HINT for the prompt/UI; classification itself is
   * always the model's call.
   */
  private async snapshotForClassification(stagedDir: string): Promise<{
    snapshot: CheckoutSnapshot
    entryPresent: boolean | null
    entryHint: string | null
  }> {
    const collected = await collectCheckoutSnapshot(stagedDir, { fs: this.fs })
    const manifest = await readCheckoutManifestState(stagedDir, this.fs)
    const source = manifest.manifest ?? {}
    const summary: CheckoutManifestSummary = {
      name: stringOrNull(source['name']),
      version: stringOrNull(source['version']),
      description: stringOrNull(source['description']),
      main: stringOrNull(source['main']),
      hasBuildScript: hasNonEmptyBuildScript(source['scripts']),
    }
    const snapshot: CheckoutSnapshot = {
      readme: collected.readme,
      entries: collected.entries,
      topLevelCount: collected.topLevelCount,
      manifest: manifest.manifest === null ? null : summary,
    }
    // The entry hint uses the SAME resolver as the commit phase, over the full
    // raw manifest (so `main` *and* `exports` count) — the prompt can therefore
    // never suggest an entry different from the one that lands in the record.
    const entry = await this.resolveEntryIn(stagedDir, source)
    return { snapshot, entryPresent: entry !== null, entryHint: entry }
  }

  /** One completion call over the shared analyzer prompt contract. */
  private async runCompletion(
    complete: DownloadCompletion,
    options: ClassifyDownloadOptions,
    snapshot: CheckoutSnapshot,
  ): Promise<ReturnType<typeof parseAnalysisOutput>> {
    if (options.provider === undefined || options.model === undefined) {
      throw marketError('market/llm-unconfigured')
    }
    // Reuse the analyzer's own prompt builder (single source for the output
    // contract, the README cap, the listing and the per-field 200-char cap).
    const prompt = buildAnalyzePrompt(snapshot)
    const text = await complete({
      provider: options.provider,
      model: options.model,
      system: prompt.system,
      user: prompt.user,
    }).catch((error: unknown) => {
      // Normalize a transport failure the same way the analyzer orchestrator
      // does, so the caller's stable errorCode is `market/llm-failed` rather
      // than an arbitrary Error message.
      if (error instanceof MarketError) throw error
      throw new MarketError(
        'market/llm-failed',
        'The smart-install analysis model call failed.',
        { cause: error },
      )
    })
    return parseAnalysisOutput(text)
  }

  private async probeEntry(stagedDir: string, entry: string): Promise<boolean | undefined> {
    return probeCheckoutEntry(
      (relative) => this.fs.stat(join(stagedDir, ...relative.split('/'))).then((stat) => stat !== null && stat.isFile()),
      entry,
    )
  }

  /**
   * The mechanically resolved runnable entry of one checkout, or null:
   * explicit/manifest resolution (`resolveCheckoutEntry` over the real manifest,
   * so `main`/`exports` count) followed by the conventional `index.js` fallback,
   * each probed for existence. Shared by the classification prompt and the
   * commit phase so both agree.
   */
  private async resolveEntryIn(stagedDir: string, manifest: Record<string, unknown>): Promise<string | null> {
    const resolved = resolveCheckoutEntry(undefined, manifest)
    const seen = new Set<string>()
    for (const candidate of [resolved, DEFAULT_CHECKOUT_ENTRY]) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const stat = await this.fs.stat(join(stagedDir, ...candidate.split('/')))
      if (stat !== null && stat.isFile()) return candidate
    }
    return null
  }

  /** Mechanically resolved runnable entry of a staged checkout (or null). */
  private async resolveStagedEntry(stagedDir: string): Promise<string | null> {
    const state = await readCheckoutManifestState(stagedDir, this.fs)
    return this.resolveEntryIn(stagedDir, state.manifest ?? {})
  }

  /**
   * **External compatibility surface (deprecated in favour of the three
   * phases).** One-shot clone + file: it does the whole download in a single
   * call, classifies mechanically (entry probe, NOT the model) and therefore
   * cannot show progress, cannot be cancelled between phases and can mis-file a
   * skills pack that ships an `index.js`.
   *
   * No code in this package calls it any more — the control layer migrated to
   * {@link PluginInstaller.prepareDownload} / `classifyDownload` /
   * `commitDownload` — and it is kept only because {@link InstallPluginInput} /
   * {@link InstalledPlugin} were exported, so an out-of-tree caller may still
   * use them. New callers must use the three phases.
   *
   * Order matters: the checkout is inspected (entry + classification) BEFORE
   * anything else, and **no package manager runs** — the dependency step lives
   * in the standalone {@link installCheckoutDependencies} and is never part of a
   * download. A checkout without a runnable entry is not a failure either: it is
   * filed with a null entry and a `skills`/`other` classification.
   *
   * @throws {MarketError} `gate/consent-required` when not confirmed;
   * `install/*` on pipeline failures; `record/*` on invalid input.
   */
  async install(input: InstallPluginInput): Promise<InstalledPlugin> {
    const root = input.repositoryRoot
    if (!input.confirmed) {
      throw new MarketError(
        'gate/consent-required',
        'Installing a plugin requires an explicit TrustGate confirmation; nothing was downloaded or written.',
        { path: root },
      )
    }
    const ownerRepo = parseRepositorySlug(input.ownerRepo)
    if (!isValidPluginKey(input.key)) {
      throw new MarketError('record/key-invalid', `"${input.key}" is not a valid stable plugin-market key.`)
    }

    // Resolve the target tuple: v2 ref installs derive key + localDirName from
    // the (owner, repo, ref-kind, ref) identity; legacy installs use the
    // caller-provided key and single-level directory.
    const target = resolveInstallTarget(ownerRepo, input)
    const key = target.key
    const dirName = target.dirName
    const refKind = target.refKind
    const refName = target.refName
    if (input.entry !== undefined && !isCheckoutEntryPath(input.entry)) {
      throw new MarketError('record/invalid', `entry "${input.entry}" is not a valid checkout-relative entry path.`)
    }

    // Conventions (.npmrc with auto-install-peers=false) must exist before the
    // dependency step; ensureLayout is idempotent.
    await new RepositoryDirectory(this.fs).ensureLayout(root)
    const store = this.store ?? new PluginRecordStore(repositoryRecordsPath(root), { fs: this.fs })
    const existing = await store.get(key)
    await this.assertTargetFree(store, key, dirName, root)

    const finalDir = join(root, ...dirName.split('/'))
    const tmpDir = join(root, `.install-${key}-${process.pid}-${nextTempId++}`)
    const oldDir = existing && existing.localDirName !== dirName ? join(root, ...existing.localDirName.split('/')) : null
    try {
      await this.cloneSource(ownerRepo, tmpDir, {
        depth: input.depth ?? 1,
        refKind,
        ref: refName,
      })
      // Inspect first: what the checkout is decides the entry/classification.
      const staged = await this.stageCheckout(tmpDir, input)
      // The download path NEVER installs dependencies (see the class docs):
      // `pnpm install` lives in the standalone installCheckoutDependencies for a
      // later explicit action. The fact is reported so callers can prompt for it.
      const dependencyNote = 'Dependencies were not installed; run the dependency step explicitly when you need them.'
      const dependenciesInstalled = false
      const entryNote = staged.entryNote === null ? dependencyNote : `${staged.entryNote} ${dependencyNote}`
      const commit = input.commit ?? await this.readHeadSha(tmpDir)

      // Swap the staged checkout into place (previous one is removed first).
      // Nested v2 targets need their parent chain created before the rename.
      await this.fs.mkdirp(dirname(finalDir))
      if ((await this.fs.lstat(finalDir)) !== null) await this.fs.rmrf(finalDir)
      await this.fs.rename(tmpDir, finalDir)

      const record = await store.register({
        key,
        source: refKind === undefined
          ? { kind: 'github', repository: ownerRepo, version: refName ?? input.version ?? null, commit: commit ?? null }
          : { kind: 'github', refKind, repository: ownerRepo, version: refName, commit: commit ?? null },
        localDirName: dirName,
        // exactOptionalPropertyTypes: a runnable entry is attached only when one
        // was resolved; an entry-less checkout registers with a null entry.
        ...(staged.entry === null ? {} : { entry: staged.entry }),
        classification: staged.classification,
      }, { trusted: true })
      // Remove a stale checkout of the same key that used a former directory
      // name. Best effort: the record already points at the new checkout.
      if (oldDir && oldDir !== finalDir) {
        await this.fs.rmrf(oldDir).catch(() => undefined)
      }
      return {
        record,
        checkoutDir: finalDir,
        classification: staged.classification,
        entry: staged.entry,
        entryNote,
        dependenciesInstalled,
      }
    } catch (error) {
      await this.fs.rmrf(tmpDir).catch(() => undefined)
      if (error instanceof MarketError) throw error
      throw new MarketError('install/io', 'The plugin install failed unexpectedly.', { path: root, cause: error })
    }
  }

  /**
   * Resolve what the staged checkout is: the entry it carries (if any), its
   * classification tag and its manifest state (needed by the dependency step).
   *
   * The entry probe wins over the caller's classification hint: a checkout with
   * a runnable entry is always classified `plugin` (a preview-time guess of
   * `skills`/`other` must never demote a real plugin to an entry-less record).
   * The explicit classification only contributes when no runnable entry exists —
   * and even then only narrows `other` to `skills`.
   *
   * A checkout without a runnable entry — an unreadable/absent manifest, a
   * manifest entry that is not there yet, or an explicit non-plugin
   * classification — is filed with a null entry instead of failing the
   * install: nothing is deleted and the record stays manageable (the control
   * layer withholds the loader row).
   */
  private async stageCheckout(stagedDir: string, input: InstallPluginInput): Promise<StagedCheckout> {
    const manifestState = await this.readManifestState(stagedDir)
    const resolved = resolveCheckoutEntry(input.entry, manifestState.manifest ?? {})
    // Probe exactly two candidates: the resolved entry (explicit override →
    // manifest main/exports → conventional index.js) and the conventional
    // fallback, so a manifest that points at a not-yet-built file still
    // installs through a present index.js. A resolved entry that is absent is
    // never second-guessed by another manifest field: if neither candidate
    // exists the checkout is filed without an entry.
    const entry = await this.firstExistingEntry(stagedDir, [resolved, DEFAULT_CHECKOUT_ENTRY])
    if (entry !== null) {
      return { entry, entryNote: null, classification: 'plugin', manifest: manifestState.manifest }
    }
    const note = manifestState.manifest === null
      ? `The checkout package.json could not be used${manifestState.note === null ? '' : ` (${manifestState.note})`}. Neither the manifest entry nor the conventional "${DEFAULT_CHECKOUT_ENTRY}" exists inside the checkout.`
      : `The resolved plugin entry "${resolved}" does not exist inside the checkout (the conventional "${DEFAULT_CHECKOUT_ENTRY}" was tried as well).`
    return {
      entry: null,
      entryNote: note,
      classification: input.classification === 'skills' ? 'skills' : 'other',
      manifest: manifestState.manifest,
    }
  }

  /** First candidate entry that exists as a file inside the checkout, or null. */
  private async firstExistingEntry(stagedDir: string, candidates: readonly string[]): Promise<string | null> {
    const seen = new Set<string>()
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      const target = join(stagedDir, ...candidate.split('/'))
      const stat = await this.fs.stat(target)
      if (stat !== null && stat.isFile()) return candidate
    }
    return null
  }

  /** A second managed plugin must never share the target directory. */
  private async assertTargetFree(
    store: PluginRecordStore,
    key: PluginMarketKey,
    dirName: string,
    root: string,
  ): Promise<void> {
    const other = (await store.list()).find((record) => record.key !== key && record.localDirName === dirName)
    if (other) {
      throw new MarketError(
        'install/dir-in-use',
        `The checkout directory "${dirName}" is already used by plugin "${other.key}".`,
        { path: join(root, ...dirName.split('/')) },
      )
    }
    const stat = await this.fs.lstat(join(root, ...dirName.split('/')))
    if (stat === null) return
    const existing = await store.get(key)
    if (existing?.localDirName === dirName) return // overwrite update of our own checkout
    // Only an empty directory may be taken over. Anything else — including a
    // directory holding its own `.git` — is treated as user-owned data (a
    // hand-made git repository, sources, notes) and refused: the presence of
    // `.git` alone is not proof of a managed checkout, and letting it through
    // would make the swap step's rmrf delete it. Fail loudly instead.
    if (!(await this.isEmptyDir(join(root, ...dirName.split('/'))))) {
      throw new MarketError(
        'install/dir-exists',
        `The directory "${dirName}" already exists and is not a checkout managed by this plugin manager; refusing to overwrite it.`,
        { path: join(root, ...dirName.split('/')) },
      )
    }
  }

  private async isEmptyDir(dir: string): Promise<boolean> {
    try {
      return (await this.fs.readdir(dir)).length === 0
    } catch {
      return false
    }
  }

  private async cloneSource(
    slug: string,
    target: string,
    opts: { depth: number; refKind: 'branch' | 'tag' | undefined; ref: string | null },
  ): Promise<void> {
    const args: string[] = ['clone']
    if (opts.refKind === undefined) {
      // Legacy behavior: a caller-supplied pin (branch or tag name) is
      // selected through git's --branch inside the shallow block.
      if (opts.depth > 0) {
        args.push('--depth', String(opts.depth))
        if (opts.ref) args.push('--branch', opts.ref, '--single-branch')
      }
    } else if (opts.refKind === 'branch') {
      if (opts.depth > 0) args.push('--depth', String(opts.depth))
      if (opts.ref) args.push('--branch', opts.ref, '--single-branch')
    } else {
      // Tag install: git resolves a --branch tag into a detached checkout.
      // Annotated tags need the tag object, so do not force --single-branch.
      if (opts.ref && opts.ref.length > 0) args.push('--branch', opts.ref)
    }
    args.push(`https://github.com/${slug}.git`, target)
    await this.runChecked('git', args, undefined, 'install/git-failed', 'The git clone step failed.')
  }

  private async readHeadSha(checkoutDir: string): Promise<string | null> {
    const outcome = await this.run('git', ['-C', checkoutDir, 'rev-parse', 'HEAD'])
    const sha = outcome.stdout.trim()
    return outcome.code === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : null
  }

  private async runChecked(
    command: string,
    args: readonly string[],
    options: RunOptions | undefined,
    code: 'install/git-failed' | 'install/deps-failed',
    message: string,
  ): Promise<void> {
    const outcome = await this.run(command, args, options)
    if (outcome.code !== 0) {
      const detail = tail(outcome.stderr) || tail(outcome.stdout) || `exit code ${outcome.code}`
      // exactOptionalPropertyTypes: only attach a path when one exists.
      const errorOptions: MarketErrorOptions = {}
      if (options?.cwd !== undefined) errorOptions.path = options.cwd
      throw new MarketError(code, `${message} (${detail})`, errorOptions)
    }
  }

  /**
   * Read the staged checkout's package.json through the injected filesystem
   * (tolerant: a missing/broken manifest is `manifest: null` + note).
   */
  private readManifestState(stagedDir: string): Promise<ManifestState> {
    return readCheckoutManifestState(stagedDir, this.fs)
  }
}

/**
 * Install one checkout's dependencies (`pnpm install` under the repository
 * install conventions: root `.npmrc` with `auto-install-peers=false` plus the
 * upward shared-harness links).
 *
 * **Not part of the download path** — no download phase calls this. It exists
 * for a later, explicit user action ("install dependencies" for an already
 * downloaded checkout); the download records `dependenciesInstalled: false`
 * until that action runs.
 *
 * @throws {MarketError} `install/deps-failed` when the command exits non-zero
 * (including a missing pnpm binary: `spawn pnpm ENOENT`).
 */
export async function installCheckoutDependencies(
  checkoutDir: string,
  run: CommandRunner = nodeCommandRunner,
): Promise<void> {
  const outcome = await run('pnpm', ['install'], { cwd: checkoutDir })
  if (outcome.code !== 0) {
    const detail = tail(outcome.stderr) || tail(outcome.stdout) || `exit code ${outcome.code}`
    throw new MarketError(
      'install/deps-failed',
      `Installing the checkout dependencies failed (is pnpm available, and did the install follow the repository install conventions?). (${detail})`,
      { path: checkoutDir },
    )
  }
}

/**
 * Read and parse one checkout's package.json, failing loudly
 * (`install/package-invalid`) when it is absent, unreadable, not JSON or not a
 * JSON object. The install pipeline uses the tolerant reader below instead —
 * this is for callers that must have a manifest.
 */
export function readCheckoutManifest(checkoutDir: string, fs: FsLike = NodeFs): Promise<Record<string, unknown>> {
  return readCheckoutManifestState(checkoutDir, fs).then((state) => {
    if (state.manifest === null) {
      throw new MarketError(
        'install/package-invalid',
        `The checkout package.json could not be read or parsed${state.note === null ? '' : ` (${state.note})`}.`,
        { path: join(checkoutDir, 'package.json') },
      )
    }
    return state.manifest
  })
}

/**
 * Tolerantly read one checkout's package.json: a missing, unreadable or
 * unparsable manifest yields `manifest: null` plus a human-readable note
 * instead of an error, so callers can skip manifest-dependent steps (entry
 * resolution, dependency installation) and still file the checkout.
 */
export async function readCheckoutManifestState(checkoutDir: string, fs: FsLike = NodeFs): Promise<ManifestState> {
  const path = join(checkoutDir, 'package.json')
  let text: string
  try {
    text = await fs.readFile(path)
  } catch {
    return { manifest: null, note: 'the file is missing or unreadable' }
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return { manifest: null, note: 'the file is not valid JSON' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { manifest: null, note: 'the file is not a JSON object' }
  }
  return { manifest: value as Record<string, unknown>, note: null }
}

let nextTempId = 0

/** Tolerant package.json read of one staged checkout (see {@link readCheckoutManifestState}). */
export interface ManifestState {
  /** Parsed manifest object, or null when absent/unreadable/not an object. */
  readonly manifest: Record<string, unknown> | null
  /** Why the manifest is null (null when it parsed). */
  readonly note: string | null
}

/** Resolved classification/entry of one staged checkout (see {@link PluginInstaller}). */
interface StagedCheckout {
  /** Runnable entry to register, or null when the checkout has none. */
  readonly entry: string | null
  /** Why the entry is null (null when an entry was registered). */
  readonly entryNote: string | null
  readonly classification: PluginMarketClassification
  /** Parsed manifest, or null when absent/unreadable (gates the dependency step). */
  readonly manifest: Record<string, unknown> | null
}

/** Normalized install destination of one {@link PluginInstaller.install} run. */
interface InstallTarget {
  readonly key: PluginMarketKey
  readonly dirName: string
  /** Set for v2 ref installs (legacy installs leave it undefined). */
  readonly refKind: 'branch' | 'tag' | undefined
  /** Branch/tag name to clone (null for a legacy unpinned install). */
  readonly refName: string | null
}

/**
 * Resolve the checkout destination from the install input. A v2 ref install
 * (`refKind` + `ref`) derives its key through {@link pluginKeyForGithubRef}
 * and its `<owner>/<repo>/<kind>/<refSeg>` localDirName; a legacy install uses
 * the caller-supplied key and single-level directory name.
 */
export function resolveInstallTarget(repository: string, input: InstallPluginInput): InstallTarget {
  const slug = parseRepositorySlug(repository)
  if (input.refKind === undefined) {
    const dirName = input.localDirName ?? input.key
    if (!isLocalDirSegment(dirName)) {
      throw new MarketError('record/invalid', `localDirName "${dirName}" is not a valid single-segment checkout directory name (legacy installs must not carry a multi-level ref path; pass refKind + ref instead).`)
    }
    return {
      key: input.key,
      dirName,
      refKind: undefined,
      refName: input.ref ?? input.version ?? null,
    }
  }
  if (input.refKind !== 'branch' && input.refKind !== 'tag') {
    throw new MarketError('record/invalid', `refKind "${String(input.refKind)}" must be "branch" or "tag".`)
  }
  const ref = input.ref ?? input.version ?? null
  if (ref === null || ref.length === 0) {
    throw new MarketError('record/invalid', 'A v2 ref install requires a branch/tag name in "ref".', { path: slug })
  }
  const slash = slug.indexOf('/')
  const owner = slug.slice(0, slash)
  const repo = slug.slice(slash + 1)
  if (!isLocalDirSegment(owner) || !isLocalDirSegment(repo)) {
    throw new MarketError(
      'record/invalid',
      `The slug "${slug}" cannot be used as directory segments (owner/repo must each be a path-safe single segment).`,
      { path: slug },
    )
  }
  const refSeg = refSegOf(ref)
  if (refSeg === null) {
    throw new MarketError('record/invalid', `The ref "${ref}" cannot be encoded into a path-safe ref segment.`, { path: slug })
  }
  const key = pluginKeyForGithubRef(slug, input.refKind, ref)
  if (input.key !== key) {
    throw new MarketError(
      'record/key-invalid',
      `The v2 ref install key must equal pluginKeyForGithubRef("${slug}", "${input.refKind}", "${ref}") — got "${input.key}".`,
      { path: slug },
    )
  }
  return {
    key,
    dirName: `${owner}/${repo}/${input.refKind}/${refSeg}`,
    refKind: input.refKind,
    refName: ref,
  }
}

/**
 * Resolve the plugin entry of one checkout: explicit override, then
 * package.json `main`, then `exports["."]` (string or import/node/require/
 * default), normalized to a checkout-relative path; the conventional
 * {@link DEFAULT_CHECKOUT_ENTRY} is the fallback.
 */
export function resolveCheckoutEntry(provided: string | undefined, manifest: Record<string, unknown>): string {
  const fromMain = typeof manifest.main === 'string' ? manifest.main : undefined
  const fromExports = entryFromExports(manifest.exports)
  for (const candidate of [provided, fromMain, fromExports]) {
    if (candidate === undefined) continue
    const normalized = normalizeCheckoutEntry(candidate)
    if (normalized !== null) return normalized
  }
  return DEFAULT_CHECKOUT_ENTRY
}

function entryFromExports(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const root = value as Record<string, unknown>
  const dot = root['.']
  if (typeof dot === 'string') return dot
  if (dot !== null && typeof dot === 'object' && !Array.isArray(dot)) {
    const targets = dot as Record<string, unknown>
    for (const key of ['import', 'node', 'require', 'default']) {
      const entry = targets[key]
      if (typeof entry === 'string') return entry
    }
  }
  return undefined
}

function tail(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  return lines.slice(-3).join(' ').slice(0, 400)
}
