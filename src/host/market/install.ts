/**
 * Plugin download/install pipeline: clone the GitHub checkout into the local
 * source repository, install its dependencies under the store conventions
 * (root `.npmrc` with peer auto-install off + upward shared harness links),
 * resolve and verify the plugin entry, then register the record. Everything
 * is staged in a temp sibling directory and swapped in only on success, so a
 * failed install never destroys a previously working checkout or record.
 *
 * The whole pipeline is gated by the TrustGate consent flag: with
 * `confirmed: false` nothing is fetched, cloned or written (`gate/consent-required`).
 * Records are registered with `enabled: false`; after a confirmed install the
 * trust decision (`trusted` + `trustedAt`) is written in the same step. A
 * same-key re-install is an overwrite update and requires its own
 * confirmation.
 *
 * Directory conventions:
 * - v2 ref installs (`refKind` + `ref` supplied) clone into the multi-level
 *   target `<root>/<owner>/<repo>/<branch|tag>/<refSeg>` and register the
 *   record with a per-`(owner, repo, ref-kind, ref)` key and a source carrying
 *   `refKind`. Distinct refs of the same repository coexist as independent
 *   records; reinstalling the same tuple is an overwrite update of its own
 *   checkout.
 * - legacy installs (no `refKind`) keep the pre-v2 behavior: checkout under a
 *   caller-provided single-level `localDirName` (defaulting to the key).
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import type { PluginMarketKey, PluginMarketRecord } from '../../types.ts'
import { MarketError, type MarketErrorOptions } from './errors.ts'
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

/** Input of one {@link PluginInstaller.install} run. */
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
  /** Explicit entry override; otherwise resolved from the manifest. */
  readonly entry?: string
  /** TrustGate consent — false refuses the install before any side effect. */
  readonly confirmed: boolean
  /** Shallow clone depth (default 1; 0 = full clone). */
  readonly depth?: number
}

/** Successful install: the registered record and its checkout directory. */
export interface InstalledPlugin {
  readonly record: PluginMarketRecord
  readonly checkoutDir: string
}

/** Options for {@link PluginInstaller}. */
export interface PluginInstallerOptions {
  readonly fs?: FsLike
  readonly run?: CommandRunner
  /** Records store; defaults to `<root>/plugins.json` over the same fs. */
  readonly store?: PluginRecordStore
}

/**
 * The download/install pipeline. Git/pnpm/fs are injectable; the pipeline
 * never touches the network itself.
 */
export class PluginInstaller {
  private readonly fs: FsLike
  private readonly run: CommandRunner
  private readonly store: PluginRecordStore | undefined

  constructor(options: PluginInstallerOptions = {}) {
    this.fs = options.fs ?? NodeFs
    this.run = options.run ?? nodeCommandRunner
    this.store = options.store
  }

  /**
   * Clone, install, resolve the entry and register one plugin checkout.
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
      await this.installDependencies(tmpDir)
      const manifest = await this.readManifest(tmpDir)
      const entry = resolveCheckoutEntry(input.entry, manifest)
      await this.assertEntryExists(tmpDir, entry)
      const headSha = await this.readHeadSha(tmpDir)

      // Swap the staged checkout into place (previous one is removed first).
      // Nested v2 targets need their parent chain created before the rename.
      await this.fs.mkdirp(dirname(finalDir))
      if ((await this.fs.lstat(finalDir)) !== null) await this.fs.rmrf(finalDir)
      await this.fs.rename(tmpDir, finalDir)

      const record = await store.register({
        key,
        source: refKind === undefined
          ? { kind: 'github', repository: ownerRepo, version: refName ?? input.version ?? null, commit: input.commit ?? headSha ?? null }
          : { kind: 'github', refKind, repository: ownerRepo, version: refName, commit: input.commit ?? headSha ?? null },
        localDirName: dirName,
        entry,
      }, { trusted: true })
      // Remove a stale checkout of the same key that used a former directory
      // name. Best effort: the record already points at the new checkout.
      if (oldDir && oldDir !== finalDir) {
        await this.fs.rmrf(oldDir).catch(() => undefined)
      }
      return { record, checkoutDir: finalDir }
    } catch (error) {
      await this.fs.rmrf(tmpDir).catch(() => undefined)
      if (error instanceof MarketError) throw error
      throw new MarketError('install/io', 'The plugin install failed unexpectedly.', { path: root, cause: error })
    }
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

  private async installDependencies(checkoutDir: string): Promise<void> {
    await this.runChecked(
      'pnpm',
      ['install'],
      { cwd: checkoutDir },
      'install/deps-failed',
      'Installing the checkout dependencies failed (is pnpm available, and did the install follow the repository install conventions?).',
    )
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

  private async readManifest(checkoutDir: string): Promise<Record<string, unknown>> {
    try {
      const text = await this.fs.readFile(join(checkoutDir, 'package.json'))
      const value = JSON.parse(text) as unknown
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('not an object')
      }
      return value as Record<string, unknown>
    } catch (error) {
      throw new MarketError(
        'install/package-invalid',
        'The checkout package.json could not be read or parsed.',
        { path: join(checkoutDir, 'package.json'), cause: error },
      )
    }
  }

  private async assertEntryExists(checkoutDir: string, entry: string): Promise<void> {
    const target = join(checkoutDir, ...entry.split('/'))
    const stat = await this.fs.stat(target)
    if (stat === null || !stat.isFile()) {
      throw new MarketError(
        'install/entry-missing',
        `The resolved plugin entry "${entry}" does not exist inside the checkout (fell back to the conventional "${DEFAULT_CHECKOUT_ENTRY}" when the manifest resolved none).`,
        { path: target },
      )
    }
  }
}

let nextTempId = 0

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
