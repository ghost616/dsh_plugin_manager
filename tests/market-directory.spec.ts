import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RepositoryDirectory } from '../src/host/market/directory.ts'
import { NodeFs } from '../src/host/market/fs.ts'
import {
  PNPM_INSTALL_CONVENTIONS,
  repositoryConventionsPath,
  repositorySharedScopePath,
} from '../src/host/market/layout.ts'
import { errno, MemoryFs } from './support/memory-fs.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

/** Memory fs whose file writes are denied (writability-probe failure). */
class ReadOnlyMemoryFs extends MemoryFs {
  override async writeFile(_path: string, _data: string): Promise<void> {
    throw errno('EACCES', 'permission denied')
  }
}

describe('RepositoryDirectory validation', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('directory') })
  afterAll(async () => { await removeTmp(tmp) })

  it('reports a missing path with repository/not-exist', async () => {
    const missing = join(tmp, 'does-not-exist')
    const result = await new RepositoryDirectory(NodeFs).validate(missing)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('repository/not-exist')
      expect(result.root).toBe(missing)
      expect(result.message.length).toBeGreaterThan(0)
    }
  })

  it('reports a file path with repository/not-directory', async () => {
    const file = join(tmp, 'iam-a-file')
    await writeFile(file, 'x', 'utf8')
    const result = await new RepositoryDirectory(NodeFs).validate(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('repository/not-directory')
  })

  it('accepts an existing writable directory and cleans its probe file', async () => {
    const dir = join(tmp, 'ready')
    await mkdir(dir)
    const result = await new RepositoryDirectory(NodeFs).validate(dir)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.root).toBe(dir)
    const leftover = await readdir(dir)
    expect(leftover).toEqual([])
  })

  it('reports a non-writable directory with repository/not-writable (mock fs)', async () => {
    const fs = new ReadOnlyMemoryFs()
    await fs.mkdirp('/repo')
    const result = await new RepositoryDirectory(fs).validate('/repo')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('repository/not-writable')
  })

  it('covers existence and directory-ness through the mock fs too', async () => {
    const fs = new MemoryFs()
    await fs.mkdirp('/repo')
    await fs.writeFile('/repo/file', 'x')
    expect((await new RepositoryDirectory(fs).validate('/repo')).ok).toBe(true)
    const missing = await new RepositoryDirectory(fs).validate('/gone')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('repository/not-exist')
    const file = await new RepositoryDirectory(fs).validate('/repo/file')
    expect(file.ok).toBe(false)
    if (!file.ok) expect(file.code).toBe('repository/not-directory')
  })
})

describe('RepositoryDirectory layout initialization', () => {
  let tmp: string
  let root: string
  beforeAll(async () => {
    tmp = await makeSuiteTmp('directory-layout')
    root = join(tmp, 'repo')
    await mkdir(root)
  })
  afterAll(async () => { await removeTmp(tmp) })

  it('creates the shared scope and the pnpm conventions file', async () => {
    const directory = new RepositoryDirectory(NodeFs)
    const created = await directory.ensureLayout(root)
    const scope = repositorySharedScopePath(root)
    const conventions = repositoryConventionsPath(root)
    expect(created).toEqual(expect.arrayContaining([scope, conventions]))
    const content = await readFile(conventions, 'utf8')
    expect(content).toContain('auto-install-peers=false')
    expect(await readdir(join(root, 'node_modules', '@deepseek-ai'))).toEqual([])
  })

  it('is idempotent and never overwrites an existing conventions file', async () => {
    const directory = new RepositoryDirectory(NodeFs)
    const conventions = repositoryConventionsPath(root)
    await writeFile(conventions, 'custom content', 'utf8')
    const created = await directory.ensureLayout(root)
    expect(created).toEqual([])
    expect(await readFile(conventions, 'utf8')).toBe('custom content')
  })

  it('writes the documented pnpm conventions', () => {
    expect(PNPM_INSTALL_CONVENTIONS).toContain('auto-install-peers=false')
    expect(PNPM_INSTALL_CONVENTIONS).toContain('@deepseek-ai')
  })
})
