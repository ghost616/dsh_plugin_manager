/**
 * Pre-download preview of a GitHub plugin repository: resolves the default
 * branch (with main/master fallbacks), reads the remote `package.json` and
 * summarizes name/version/dependencies for the TrustGate confirmation. When
 * the raw manifest is unreadable the preview degrades to a friendly reason
 * with a stable code — confirmation is not blocked, but the UI marks the
 * dependencies as unreadable ("依赖不可读").
 */

import type {
  PluginDependencyPreview,
  PluginManifestPreview,
  PluginPreviewOutcome,
} from '../../types.ts'
import { MarketError } from './errors.ts'
import {
  defaultFetchLike,
  githubFetch,
  GitHubMarket,
  parseGitHubJson,
  parseRepositorySlug,
  type FetchLike,
  type GitHubMarketOptions,
  type GitHubRequestOptions,
} from './github.ts'

const RAW_BASE = 'https://raw.githubusercontent.com'

/** A previewer with injectable fetch/token (never stores credentials). */
export interface PluginPreviewerOptions extends GitHubMarketOptions {}

/**
 * Fetch-based plugin preview. Every network hop goes through the injectable
 * fetch; tokens are resolved per request and never kept on the outcome.
 */
export class PluginPreviewer {
  private readonly github: GitHubMarket
  private readonly fetchImpl: FetchLike

  constructor(options: PluginPreviewerOptions = {}) {
    this.github = new GitHubMarket(options)
    this.fetchImpl = options.fetchImpl ?? defaultFetchLike
  }

  /**
   * Preview one `owner/repo` plugin before download.
   * @returns a `ready` outcome with the parsed manifest, or a `degraded`
   * outcome carrying a friendly reason and the underlying `github/*` code when
   * the manifest (or even the repository metadata) is unreadable.
   * @throws {MarketError} `github/bad-request` for a malformed slug.
   */
  async preview(slug: string, signal?: AbortSignal): Promise<PluginPreviewOutcome> {
    const ownerRepo = parseRepositorySlug(slug)
    let meta
    try {
      meta = await this.github.repositoryMeta(
        ownerRepo,
        // exactOptionalPropertyTypes: attach the caller's signal only when set.
        signal === undefined ? {} : { signal },
      )
    } catch (error) {
      if (error instanceof MarketError) {
        return {
          status: 'degraded',
          summary: emptyManifest(),
          reason: `The repository metadata could not be read (${error.message}); dependencies are unreadable.`,
          code: error.code,
        }
      }
      throw error
    }

    const candidates = uniqueBranches([meta.defaultBranch, 'main', 'master'])
    let lastError: MarketError | null = null
    for (const branch of candidates) {
      try {
        const manifest = await this.readManifest(ownerRepo, branch, signal)
        return { status: 'ready', summary: manifest }
      } catch (error) {
        if (!(error instanceof MarketError)) throw error
        lastError = error
        // A missing package.json on one branch is an ordinary miss: keep
        // probing the remaining candidates; other failures stop probing.
        if (error.code !== 'github/not-found') break
      }
    }
    const failure = lastError ?? new MarketError(
      'github/network',
      'The plugin manifest could not be fetched.',
    )
    return {
      status: 'degraded',
      summary: emptyManifest(),
      reason: `The plugin manifest is unreadable (${failure.message}); only repository metadata is available and dependencies are marked unreadable.`,
      code: failure.code,
    }
  }

  /** Fetch and summarize `<owner>/<repo>/<branch>/package.json`. */
  private async readManifest(ownerRepo: string, branch: string, signal?: AbortSignal): Promise<PluginManifestPreview> {
    const url = `${RAW_BASE}/${ownerRepo}/${branch}/package.json`
    // Raw GitHub reads never carry the Authorization header.
    const request: GitHubRequestOptions = { auth: false }
    if (signal !== undefined) request.signal = signal
    const body = await githubFetch(this.fetchImpl, url, request)
    const data = parseGitHubJson(body.text, url)
    const manifest = summarizeManifest(data)
    if (manifest === null) {
      throw new MarketError('github/bad-response', 'The package.json content is not a manifest object.', { path: url })
    }
    return manifest
  }
}

function emptyManifest(): PluginManifestPreview {
  return { name: null, version: null, dependencies: { dependencies: [], peerDependencies: [] } }
}

function uniqueBranches(branches: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const branch of branches) {
    if (branch && !seen.has(branch)) {
      seen.add(branch)
      out.push(branch)
    }
  }
  return out
}

function summarizeManifest(data: unknown): PluginManifestPreview | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const raw = data as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name : null
  const version = typeof raw.version === 'string' ? raw.version : null
  return { name, version, dependencies: summarizeDependencies(raw) }
}

function summarizeDependencies(raw: Record<string, unknown>): PluginDependencyPreview {
  return {
    dependencies: namesOf(raw.dependencies),
    peerDependencies: namesOf(raw.peerDependencies),
  }
}

function namesOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).sort()
}
