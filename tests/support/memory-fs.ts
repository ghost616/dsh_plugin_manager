import type { FsLike, FsStat } from '../../src/host/market/fs.ts'

/**
 * In-memory file system for unit tests (mock-fs requirement). Mirrors the
 * subset of `node:fs` behavior the repository layer relies on: nested
 * directories, whole-file text reads/writes, rename/unlink/rmrf and
 * missing-path `ENOENT` semantics. Symlinks are not supported (real
 * directories are used for symlink-level tests); {@link MemoryFs.symlinkDir}
 * always throws.
 */
export class MemoryFs implements FsLike {
  private root: DirNode = { kind: 'dir', children: new Map() }

  async lstat(path: string): Promise<FsStat | null> {
    return this.statLike(path)
  }

  async stat(path: string): Promise<FsStat | null> {
    return this.statLike(path)
  }

  async readFile(path: string): Promise<string> {
    const node = this.resolve(path)
    if (node === undefined) throw errno('ENOENT', `no such file: ${path}`)
    if (node.kind === 'dir') throw errno('EISDIR', `is a directory: ${path}`)
    return node.text
  }

  async writeFile(path: string, data: string): Promise<void> {
    const segments = this.segments(path)
    const name = segments.pop()
    if (name === undefined) throw errno('EISDIR', `cannot write directory: ${path}`)
    const parent = this.dirAt(segments)
    if (parent === undefined) throw errno('ENOENT', `missing parent directory: ${path}`)
    parent.children.set(name, { kind: 'file', text: data })
  }

  async mkdirp(dir: string): Promise<void> {
    let cursor = this.root
    for (const segment of this.segments(dir)) {
      let next = cursor.children.get(segment)
      if (next === undefined) {
        next = { kind: 'dir', children: new Map() }
        cursor.children.set(segment, next)
      }
      if (next.kind === 'file') throw errno('ENOTDIR', `not a directory: ${dir}`)
      cursor = next
    }
  }

  async readdir(dir: string): Promise<string[]> {
    const node = this.resolve(dir)
    if (node === undefined) throw errno('ENOENT', `no such directory: ${dir}`)
    if (node.kind === 'file') throw errno('ENOTDIR', `not a directory: ${dir}`)
    return [...node.children.keys()]
  }

  async rename(from: string, to: string): Promise<void> {
    const moved = this.take(this.segments(from))
    if (moved === undefined) throw errno('ENOENT', `cannot rename missing path: ${from}`)
    const toSegments = this.segments(to)
    const name = toSegments.pop()
    const parent = this.dirAt(toSegments)
    if (name === undefined || parent === undefined) {
      throw errno('ENOENT', `cannot rename onto missing parent: ${to}`)
    }
    parent.children.set(name, moved)
  }

  async unlink(path: string): Promise<void> {
    const removed = this.take(this.segments(path))
    if (removed === undefined) throw errno('ENOENT', `cannot unlink missing path: ${path}`)
    if (removed.kind === 'dir' && removed.children.size > 0) {
      throw errno('ENOTEMPTY', `directory not empty: ${path}`)
    }
  }

  async rmrf(path: string): Promise<void> {
    this.take(this.segments(path))
  }

  async symlinkDir(): Promise<void> {
    throw errno('EPERM', 'MemoryFs does not support symlinks')
  }

  async realpath(path: string): Promise<string> {
    return this.resolve(path) === undefined ? path : path
  }

  /** Raw node lookup for assertions (tests may cast). */
  exists(path: string): boolean {
    return this.resolve(path) !== undefined
  }

  private async statLike(path: string): Promise<FsStat | null> {
    const node = this.resolve(path)
    if (node === undefined) return null
    const isDir = node.kind === 'dir'
    return {
      isDirectory: () => isDir,
      isFile: () => node.kind === 'file',
      isSymbolicLink: () => false,
    }
  }

  private segments(path: string): string[] {
    return path.split(/[\\/]+/).filter((segment) => segment.length > 0)
  }

  private resolve(path: string): Node | undefined {
    const segments = this.segments(path)
    let cursor: Node | undefined = this.root
    for (const segment of segments) {
      if (cursor === undefined || cursor.kind !== 'dir') return undefined
      cursor = cursor.children.get(segment)
    }
    return cursor
  }

  /** Walk into `segments`, returning the directory or undefined (never creates). */
  private dirAt(segments: readonly string[]): DirNode | undefined {
    let cursor: Node = this.root
    for (const segment of segments) {
      // Explicit annotation: the union-typed cursor makes the initializer's
      // inference circular (TS7022) without it.
      const next: Node | undefined = cursor.kind === 'dir' ? cursor.children.get(segment) : undefined
      if (next === undefined) return undefined
      cursor = next
    }
    return cursor.kind === 'dir' ? cursor : undefined
  }

  /** Remove the node at `segments` from its parent and return it. */
  private take(segments: readonly string[]): Node | undefined {
    if (segments.length === 0) return undefined
    const parent = this.dirAt(segments.slice(0, -1))
    const name = segments[segments.length - 1]
    if (parent === undefined || name === undefined) return undefined
    const node = parent.children.get(name)
    if (node === undefined) return undefined
    parent.children.delete(name)
    return node
  }
}

type Node = DirNode | FileNode

interface DirNode {
  readonly kind: 'dir'
  readonly children: Map<string, Node>
}

interface FileNode {
  readonly kind: 'file'
  text: string
}

/** Build an Error carrying a Node-style errno `code` (records layer inspects it). */
export function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}
