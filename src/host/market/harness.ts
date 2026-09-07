import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { MarketError } from './errors.ts'
import { NodeFs, type FsLike } from './fs.ts'
import { repositorySharedScopePath } from './layout.ts'

/**
 * Mandatory shared-identity packages of the running harness. Every harness
 * plugin resolves its cordis/loader/typert references against these, so each
 * must resolve to the single main-process instance.
 */
export const REQUIRED_HARNESS_PACKAGES: readonly string[] = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-typert-protocol',
]

/**
 * Optional shared-identity packages linked when the running instance provides
 * them (e.g. plugins that consume `@deepseek-ai/cordis-plugin-include`).
 */
export const OPTIONAL_HARNESS_PACKAGES: readonly string[] = [
  '@deepseek-ai/cordis-plugin-include',
]

/** Resolves one package name to its absolute package-root directory, or null. */
export type HarnessPackageResolver = (name: string) => Promise<string | null>

/** Resolves one package name as a consumer inside the repository would. */
export type HarnessConsumerResolver = (name: string) => Promise<string | null>

/**
 * Production resolver: resolves from this module's own scope, i.e. from the
 * very same module graph the running dsh process uses — so the linked targets
 * are the main-process instance by construction.
 */
export function createNodePackageResolver(fs: FsLike = NodeFs): HarnessPackageResolver {
  const require = createRequire(import.meta.url)
  return async (name) => {
    let entry: string
    try {
      entry = require.resolve(name)
    } catch {
      return null
    }
    return packageRootFromEntry(entry, fs)
  }
}

/** One shared harness link present under `<root>/node_modules/@deepseek-ai`. */
export interface HarnessLinkEntry {
  /** Full package name, e.g. `@deepseek-ai/cordis`. */
  readonly name: string
  /** Link path inside the shared scope. */
  readonly linkPath: string
  /** Canonical target: the running instance's package root directory. */
  readonly target: string
  /** Whether this run created the link (false = already correct). */
  readonly created: boolean
}

/** Result of {@link SharedHarnessLinker.ensure}. */
export interface HarnessEnsureResult {
  readonly scopePath: string
  readonly links: readonly HarnessLinkEntry[]
}

/** One single-instance check entry of {@link SharedHarnessLinker.verify}. */
export interface HarnessVerifyEntry {
  readonly name: string
  /** Running-instance target; null when the package cannot be resolved. */
  readonly target: string | null
  /** Consumer resolution from inside the repository; null when unresolvable. */
  readonly resolved: string | null
  /** True when the consumer resolution lands on the running instance. */
  readonly sameInstance: boolean
}

/** Result of {@link SharedHarnessLinker.verify}. */
export interface HarnessVerifyResult {
  readonly root: string
  readonly entries: readonly HarnessVerifyEntry[]
  /** True when every required package resolves to the single instance. */
  readonly singleInstance: boolean
}

/** Options for {@link SharedHarnessLinker}. */
export interface SharedHarnessLinkerOptions {
  /** Injectable file-system adapter (defaults to {@link NodeFs}). */
  fs?: FsLike
  /** Package resolver (defaults to {@link createNodePackageResolver}). */
  resolver?: HarnessPackageResolver
  /** Consumer resolver for verification (defaults to a Node require from root). */
  consumer?: HarnessConsumerResolver
  /** Mandatory packages; defaults to {@link REQUIRED_HARNESS_PACKAGES}. */
  requiredPackages?: readonly string[]
  /** Optional packages; defaults to {@link OPTIONAL_HARNESS_PACKAGES}. */
  optionalPackages?: readonly string[]
}

/**
 * The shared-harness linker: on repository initialization it creates
 * `<root>/node_modules/@deepseek-ai` and links every shared-identity package
 * of the running dsh instance into it. Because plugin source checkouts live
 * under the repository root, their unfulfilled `@deepseek-ai/*` references
 * resolve upward through this scope to the same physical packages the main
 * process loaded — one Cordis instance, no singleton split. Install
 * conventions (`.npmrc`, peer auto-install off) keep pnpm from materializing
 * a second copy inside a checkout.
 */
export class SharedHarnessLinker {
  private readonly fs: FsLike
  private readonly resolver: HarnessPackageResolver
  private readonly consumerOverride: HarnessConsumerResolver | undefined
  private readonly requiredPackages: readonly string[]
  private readonly optionalPackages: readonly string[]

  constructor(options: SharedHarnessLinkerOptions = {}) {
    this.fs = options.fs ?? NodeFs
    this.resolver = options.resolver ?? createNodePackageResolver(this.fs)
    this.requiredPackages = options.requiredPackages ?? REQUIRED_HARNESS_PACKAGES
    this.optionalPackages = options.optionalPackages ?? OPTIONAL_HARNESS_PACKAGES
    this.consumerOverride = options.consumer
  }

  /** Create or refresh the shared harness links under `root` (idempotent). */
  async ensure(root: string): Promise<HarnessEnsureResult> {
    const scopePath = repositorySharedScopePath(root)
    try {
      await this.fs.mkdirp(scopePath)
    } catch (error) {
      throw new MarketError('harness/io', 'Failed to create the shared harness module scope.', { path: scopePath, cause: error })
    }
    const links: HarnessLinkEntry[] = []
    const required = new Set<string>(this.requiredPackages)
    for (const name of [...this.requiredPackages, ...this.optionalPackages]) {
      const rawTarget = await this.resolver(name)
      if (rawTarget === null) {
        if (required.has(name)) {
          throw new MarketError(
            'harness/resolve-failed',
            `Shared harness package "${name}" could not be resolved in the running dsh instance. The plugin market needs it to guarantee a single Cordis runtime.`,
            { path: scopePath },
          )
        }
        continue // Optional package the running instance does not provide.
      }
      const target = await this.canonicalize(rawTarget, scopePath, name)
      const linkPath = join(scopePath, shortName(name))
      const existing = await this.fs.lstat(linkPath)
      if (existing === null) {
        try {
          await this.fs.symlinkDir(target, linkPath)
          links.push({ name, linkPath, target, created: true })
        } catch (error) {
          throw new MarketError(
            'harness/io',
            `Failed to create the shared harness link for "${name}". The repository volume must support directory links (NTFS does; exFAT/FAT does not) — choose a repository directory on a link-capable volume so plugin harness references can reach the single running instance.`,
            { path: linkPath, cause: error },
          )
        }
      } else {
        const existingTarget = await this.fs.realpath(linkPath).catch(() => null)
        if (existingTarget !== target) {
          throw new MarketError(
            'harness/link-conflict',
            `The shared harness link "${linkPath}" points at ${existingTarget ?? 'an unresolvable entry'}, but the running instance is "${target}". Remove the conflicting entry so the link can be refreshed.`,
          )
        }
        links.push({ name, linkPath, target, created: false })
      }
    }
    return { scopePath, links }
  }

  /**
   * Verify that a consumer resolving from inside `root` lands on the same
   * physical instance for every required package.
   */
  async verify(root: string): Promise<HarnessVerifyResult> {
    const consumer = this.consumerOverride ?? createRootConsumer(root, this.fs)
    const entries: HarnessVerifyEntry[] = []
    for (const name of this.requiredPackages) {
      const rawTarget = await this.resolver(name)
      let target: string | null = null
      if (rawTarget !== null) {
        try {
          target = await this.fs.realpath(rawTarget)
        } catch {
          target = null
        }
      }
      let resolved: string | null = null
      try {
        resolved = await consumer(name)
      } catch {
        resolved = null
      }
      entries.push({ name, target, resolved, sameInstance: target !== null && resolved === target })
    }
    return {
      root,
      entries,
      singleInstance: entries.length > 0 && entries.every((entry) => entry.sameInstance),
    }
  }

  private async canonicalize(target: string, scopePath: string, name: string): Promise<string> {
    try {
      return await this.fs.realpath(target)
    } catch (error) {
      throw new MarketError('harness/io', `Failed to canonicalize the resolved package root of "${name}".`, { path: scopePath, cause: error })
    }
  }
}

/** `@deepseek-ai/cordis` → `cordis`. */
function shortName(name: string): string {
  const slash = name.indexOf('/')
  return slash === -1 ? name : name.slice(slash + 1)
}

/** Default consumer: a Node require resolving from the repository root. */
export function createRootConsumer(root: string, fs: FsLike = NodeFs): HarnessConsumerResolver {
  const require = createRequire(join(root, '.dsh-plugin-market-verify.js'))
  return async (name) => {
    try {
      const resolved = require.resolve(name)
      return await packageRootFromEntry(await fs.realpath(resolved), fs)
    } catch {
      return null
    }
  }
}

/** Walk up from a resolved entry file until the package root (package.json). */
async function packageRootFromEntry(entry: string, fs: FsLike): Promise<string | null> {
  let dir = dirname(entry)
  for (;;) {
    if ((await fs.lstat(join(dir, 'package.json'))) !== null) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
