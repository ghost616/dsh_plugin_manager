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
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { PluginMarketKey, PluginMarketRecord } from '../../types.ts'
import { MarketError, type MarketErrorOptions } from './errors.ts'
import { NodeFs, type FsLike } from './fs.ts'
import { parseRepositorySlug } from './github.ts'
import { RepositoryDirectory } from './directory.ts'
import { repositoryRecordsPath } from './layout.ts'
import {
  isCheckoutEntryPath,
  isLocalDirSegment,
  normalizeCheckoutEntry,
} from './paths.ts'
import { isValidPluginKey } from './keys.ts'
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
  /** Stable loader-safe key, e.g. `gh-owner-repo`. */
  readonly key: PluginMarketKey
  /** `owner/repo` slug to clone. */
  readonly ownerRepo: string
  /** Optional tag/branch pin. */
  readonly version?: string | null
  /** Optional commit override; the cloned HEAD sha is recorded otherwise. */
  readonly commit?: string | null
  /** Checkout directory name under the repository root (default: the key). */
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
    const dirName = input.localDirName ?? input.key
    if (!isLocalDirSegment(dirName)) {
      throw new MarketError('record/invalid', `localDirName "${dirName}" is not a valid checkout directory name.`)
    }
    if (input.entry !== undefined && !isCheckoutEntryPath(input.entry)) {
      throw new MarketError('record/invalid', `entry "${input.entry}" is not a valid checkout-relative entry path.`)
    }

    // Conventions (.npmrc with auto-install-peers=false) must exist before the
    // dependency step; ensureLayout is idempotent.
    await new RepositoryDirectory(this.fs).ensureLayout(root)
    const store = this.store ?? new PluginRecordStore(repositoryRecordsPath(root), { fs: this.fs })
    const existing = await store.get(input.key)
    await this.assertTargetFree(store, input.key, dirName, root)

    const finalDir = join(root, dirName)
    const tmpDir = join(root, `.install-${input.key}-${process.pid}-${nextTempId++}`)
    const oldDir = existing && existing.localDirName !== dirName ? join(root, existing.localDirName) : null
    try {
      await this.cloneSource(ownerRepo, tmpDir, {
        depth: input.depth ?? 1,
        version: input.version ?? null,
      })
      await this.installDependencies(tmpDir)
      const manifest = await this.readManifest(tmpDir)
      const entry = resolveCheckoutEntry(input.entry, manifest)
      await this.assertEntryExists(tmpDir, entry)
      const headSha = await this.readHeadSha(tmpDir)

      // Swap the staged checkout into place (previous one is removed first).
      if ((await this.fs.lstat(finalDir)) !== null) await this.fs.rmrf(finalDir)
      await this.fs.rename(tmpDir, finalDir)

      const record = await store.register({
        key: input.key,
        source: {
          kind: 'github',
          repository: ownerRepo,
          version: input.version ?? null,
          commit: input.commit ?? headSha ?? null,
        },
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
        { path: join(root, dirName) },
      )
    }
    const stat = await this.fs.lstat(join(root, dirName))
    if (stat === null) return
    const existing = await store.get(key)
    if (existing?.localDirName === dirName) return // overwrite update of our own checkout
    const hasGit = (await this.fs.lstat(join(root, dirName, '.git'))) !== null
    if (!hasGit && !(await this.isEmptyDir(join(root, dirName)))) {
      throw new MarketError(
        'install/dir-exists',
        `The directory "${dirName}" already exists and is not a managed checkout; refusing to overwrite it.`,
        { path: join(root, dirName) },
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

  private async cloneSource(slug: string, target: string, opts: { depth: number; version: string | null }): Promise<void> {
    const args: string[] = ['clone']
    if (opts.depth > 0) {
      args.push('--depth', String(opts.depth))
      if (opts.version) args.push('--branch', opts.version, '--single-branch')
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
