import { join } from 'node:path'
import { MarketError } from './errors.ts'
import { errorCode, NodeFs, type FsLike } from './fs.ts'
import {
  PNPM_INSTALL_CONVENTIONS,
  repositoryConventionsPath,
  repositorySharedScopePath,
} from './layout.ts'

/** Repository-level failure codes produced by the directory service. */
export type RepositoryFailureCode =
  | 'repository/not-exist'
  | 'repository/not-directory'
  | 'repository/not-writable'
  | 'repository/io'

/** Result of validating one repository root path. */
export type RepositoryValidation =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly root: string; readonly code: RepositoryFailureCode; readonly message: string }

/**
 * The repository directory service: startup validation of the user-configured
 * path (existence / directory-ness / writability, each with a stable error
 * code and friendly message) plus initialization of the manager-owned layout
 * once the directory is ready. All paths and file operations are injectable,
 * so unit tests run against mocks and scratch directories.
 */
export class RepositoryDirectory {
  constructor(private readonly fs: FsLike = NodeFs) {}

  /** Validate that `root` exists, is a directory and is writable. */
  async validate(root: string): Promise<RepositoryValidation> {
    let stat: Awaited<ReturnType<FsLike['stat']>>
    try {
      stat = await this.fs.stat(root)
    } catch (error) {
      return {
        ok: false,
        root,
        code: 'repository/io',
        message: `Failed to inspect the plugin source repository.`,
      }
    }
    if (stat === null) {
      return {
        ok: false,
        root,
        code: 'repository/not-exist',
        message: 'The plugin source repository does not exist yet. Create the directory or point the plugin-market Config at an existing one.',
      }
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        root,
        code: 'repository/not-directory',
        message: 'The plugin source repository path is not a directory. Choose an existing directory.',
      }
    }
    const probe = join(root, `.dsh-plugin-market-write-probe-${process.pid}-${Date.now()}`)
    try {
      await this.fs.writeFile(probe, '')
      await this.fs.unlink(probe)
    } catch (error) {
      // Best-effort cleanup of a probe that could be created but not removed.
      try {
        await this.fs.unlink(probe)
      } catch {
        // Ignore: the original error below is what matters.
      }
      if (isPermissionFailure(error)) {
        return {
          ok: false,
          root,
          code: 'repository/not-writable',
          message: 'The plugin source repository is not writable. Grant write permission (including file creation and removal) and retry.',
        }
      }
      return {
        ok: false,
        root,
        code: 'repository/io',
        message: 'The plugin source repository could not be written during the startup probe.',
      }
    }
    return { ok: true, root }
  }

  /** Create the repository root (missing-parent safe). */
  async create(root: string): Promise<void> {
    try {
      await this.fs.mkdirp(root)
    } catch (error) {
      throw new MarketError('repository/io', 'Failed to create the plugin source repository directory.', { path: root, cause: error })
    }
  }

  /**
   * Initialize the manager-owned layout inside an existing, writable root:
   * the shared `node_modules/@deepseek-ai` scope and the pnpm conventions
   * file. Idempotent: existing entries are kept untouched. Returns the paths
   * that were actually created. (The records file itself is initialized by
   * the records store on first open.)
   */
  async ensureLayout(root: string): Promise<string[]> {
    const created: string[] = []
    const scope = repositorySharedScopePath(root)
    const conventions = repositoryConventionsPath(root)
    try {
      if ((await this.fs.lstat(scope)) === null) {
        await this.fs.mkdirp(scope)
        created.push(scope)
      }
      if ((await this.fs.lstat(conventions)) === null) {
        await this.fs.writeFile(conventions, PNPM_INSTALL_CONVENTIONS)
        created.push(conventions)
      }
    } catch (error) {
      const code = error instanceof MarketError ? error.code : 'repository/io'
      throw new MarketError(code, 'Failed to initialize the plugin source repository layout.', { path: root, cause: error })
    }
    return created
  }
}

function isPermissionFailure(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
}
