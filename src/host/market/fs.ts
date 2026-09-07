import { promises as fsp } from 'node:fs'

/** Minimal structural file stat used by the repository layer. */
export interface FsStat {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** Error-code accessor normalizing Node-style errno errors. */
export function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * Injectable file-system surface of the repository layer. Production uses
 * {@link NodeFs}; tests inject mocks (in-memory or recording adapters), so no
 * module in this layer talks to `node:fs` directly and every operation can be
 * verified without touching the host machine.
 */
export interface FsLike {
  /** Stat `path` without following symlinks; null when nothing exists there. */
  lstat(path: string): Promise<FsStat | null>
  /** Stat `path`, following symlinks; null when nothing exists there. */
  stat(path: string): Promise<FsStat | null>
  /** Read a whole UTF-8 text file. */
  readFile(path: string): Promise<string>
  /** Write a whole UTF-8 text file (parent directory must exist). */
  writeFile(path: string, data: string): Promise<void>
  /** Create `dir` and any missing ancestors; succeeds when it already exists. */
  mkdirp(dir: string): Promise<void>
  /** List direct entry names of `dir`. */
  readdir(dir: string): Promise<string[]>
  /** Atomically move `from` onto `to` (same volume; replaces an existing target). */
  rename(from: string, to: string): Promise<void>
  /** Remove one file or dangling symlink. */
  unlink(path: string): Promise<void>
  /** Remove a file or directory tree, ignoring missing paths. */
  rmrf(path: string): Promise<void>
  /** Create a directory symlink (junction on Windows) at `link` → `target`. */
  symlinkDir(target: string, link: string): Promise<void>
  /** Canonical absolute path of `path`, resolving symlinks/junctions. */
  realpath(path: string): Promise<string>
}

/** Node.js implementation backing production (and real-fs tests). */
export const NodeFs: FsLike = {
  lstat: async (path) => statOf(() => fsp.lstat(path)),
  stat: async (path) => statOf(() => fsp.stat(path)),
  readFile: async (path) => fsp.readFile(path, 'utf8'),
  writeFile: async (path, data) => { await fsp.writeFile(path, data, 'utf8') },
  mkdirp: async (dir) => { await fsp.mkdir(dir, { recursive: true }) },
  readdir: async (dir) => fsp.readdir(dir, { encoding: 'utf8' }),
  rename: async (from, to) => { await fsp.rename(from, to) },
  unlink: async (path) => { await fsp.unlink(path) },
  rmrf: async (path) => { await fsp.rm(path, { recursive: true, force: true }) },
  symlinkDir: async (target, link) => {
    await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  },
  realpath: async (path) => fsp.realpath(path),
}

/** Run a stat call and normalize "missing" to null. */
async function statOf(
  stat: () => Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>,
): Promise<FsStat | null> {
  try {
    const value = await stat()
    return {
      isDirectory: () => value.isDirectory(),
      isFile: () => value.isFile(),
      isSymbolicLink: () => value.isSymbolicLink(),
    }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}
