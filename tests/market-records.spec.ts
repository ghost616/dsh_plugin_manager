import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PluginMarketKey, PluginMarketSource } from '../src/types.ts'
import { MarketError } from '../src/host/market/errors.ts'
import { NodeFs, type FsLike, type FsStat } from '../src/host/market/fs.ts'
import { parsePluginKey } from '../src/host/market/keys.ts'
import { RECORDS_SCHEMA_VERSION, PluginRecordStore } from '../src/host/market/records.ts'
import { MemoryFs } from './support/memory-fs.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

const githubSource: PluginMarketSource = {
  kind: 'github',
  repository: 'deepseek-ai/cordis',
  version: null,
  commit: null,
}

function key(value: string) {
  return parsePluginKey(value)
}

/** Assert a promise rejects with a MarketError carrying the stable code. */
async function rejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    expect((error as MarketError).code).toBe(code)
    return
  }
  throw new Error(`expected MarketError with code ${code}, but the promise resolved`)
}

describe('PluginRecordStore (real fs)', () => {
  let tmp: string
  let filePath: string
  beforeAll(async () => {
    tmp = await makeSuiteTmp('records')
    filePath = join(tmp, 'plugins.json')
  })
  afterAll(async () => { await removeTmp(tmp) })

  it('creates the default empty v1 document on first open', async () => {
    const store = new PluginRecordStore(filePath)
    expect(await store.load()).toEqual([])
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion: number; records: unknown }
    expect(raw.schemaVersion).toBe(RECORDS_SCHEMA_VERSION)
    expect(raw.records).toEqual({})
  })

  it('add applies enabled=false and untrusted defaults and persists them', async () => {
    const store = new PluginRecordStore(filePath)
    const record = await store.add({
      key: key('gh-owner-repo'),
      source: githubSource,
      localDirName: 'gh-owner-repo',
    })
    expect(record.enabled).toBe(false)
    expect(record.trusted).toBe('untrusted')
    expect(record.trustedAt).toBeNull()
    expect(Number.isNaN(Date.parse(record.installedAt))).toBe(false)
    expect(record.source).toEqual(githubSource)

    // A fresh store instance sees the persisted record with the same defaults.
    const reopened = new PluginRecordStore(filePath)
    const seen = await reopened.get(key('gh-owner-repo'))
    expect(seen).toEqual(record)

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion: number; records: Record<string, { enabled: boolean }> }
    expect(raw.schemaVersion).toBe(1)
    expect(raw.records['gh-owner-repo']?.enabled).toBe(false)
  })

  it('rejects a duplicate add with record/exists', async () => {
    const store = new PluginRecordStore(filePath)
    await rejectCode(
      store.add({ key: key('gh-owner-repo'), source: githubSource, localDirName: 'gh-owner-repo' }),
      'record/exists',
    )
  })

  it('serializes concurrent adds without losing an update', async () => {
    const store = new PluginRecordStore(filePath)
    await Promise.all([
      store.add({ key: key('gh-a-b'), source: githubSource, localDirName: 'gh-a-b' }),
      store.add({ key: key('gh-c-d'), source: githubSource, localDirName: 'gh-c-d' }),
    ])
    const keys = (await store.list()).map((record) => record.key)
    expect(keys).toEqual(['gh-a-b', 'gh-c-d', 'gh-owner-repo'])
  })

  it('setEnabled flips and persists the flag', async () => {
    const store = new PluginRecordStore(filePath)
    const enabled = await store.setEnabled(key('gh-owner-repo'), true)
    expect(enabled.enabled).toBe(true)
    expect((await new PluginRecordStore(filePath).get(key('gh-owner-repo')))?.enabled).toBe(true)
    await store.setEnabled(key('gh-owner-repo'), false)
    expect((await store.get(key('gh-owner-repo')))?.enabled).toBe(false)
  })

  it('setTrusted records the decision timestamp and persists it', async () => {
    const store = new PluginRecordStore(filePath)
    const first = await store.setTrusted(key('gh-owner-repo'), 'trusted')
    expect(first.trusted).toBe('trusted')
    expect(first.trustedAt).not.toBeNull()
    expect(Number.isNaN(Date.parse(first.trustedAt as string))).toBe(false)
    expect((await new PluginRecordStore(filePath).get(key('gh-owner-repo')))?.trusted).toBe('trusted')

    // Same-state call is a no-op (keeps the original decision timestamp).
    const second = await store.setTrusted(key('gh-owner-repo'), 'trusted')
    expect(second.trustedAt).toBe(first.trustedAt)

    const revoked = await store.setTrusted(key('gh-owner-repo'), 'revoked')
    expect(revoked.trusted).toBe('revoked')
  })

  it('reports record/not-found for missing keys and remove returns false', async () => {
    const store = new PluginRecordStore(filePath)
    await rejectCode(store.setEnabled(key('gh-missing'), true), 'record/not-found')
    await rejectCode(store.setTrusted(key('gh-missing'), 'trusted'), 'record/not-found')
    expect(await store.remove(key('gh-missing'))).toBe(false)
  })

  it('remove deletes the record and returns false on a second call', async () => {
    const store = new PluginRecordStore(filePath)
    expect(await store.remove(key('gh-a-b'))).toBe(true)
    expect(await store.get(key('gh-a-b'))).toBeNull()
    expect(await store.remove(key('gh-a-b'))).toBe(false)
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { records: Record<string, unknown> }
    expect(raw.records['gh-a-b']).toBeUndefined()
  })

  it('reports corruption and never overwrites the damaged file', async () => {
    const corruptFile = join(tmp, 'corrupt.json')
    await writeFile(corruptFile, '{not json!!', 'utf8')
    const store = new PluginRecordStore(corruptFile)
    await rejectCode(store.load(), 'record/corrupt')
    await rejectCode(store.list(), 'record/corrupt')
    expect(await readFile(corruptFile, 'utf8')).toBe('{not json!!')
  })

  it('rejects an unsupported schema version as corruption', async () => {
    const file = join(tmp, 'schema2.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 2, records: {} }), 'utf8')
    await rejectCode(new PluginRecordStore(file).load(), 'record/corrupt')
  })

  it('rejects a malformed record entry as corruption', async () => {
    const file = join(tmp, 'malformed.json')
    const broken = {
      schemaVersion: 1,
      records: {
        'gh-owner-repo': { key: 'gh-owner-repo', source: githubSource, installedAt: new Date().toISOString(), enabled: false, trusted: 'untrusted', trustedAt: null },
      },
    }
    await writeFile(file, JSON.stringify(broken), 'utf8')
    await rejectCode(new PluginRecordStore(file).load(), 'record/corrupt')
  })

  it('rejects a map key that disagrees with the record key', async () => {
    const file = join(tmp, 'mismatch.json')
    const record = {
      key: 'gh-owner-repo', source: githubSource, localDirName: 'gh-owner-repo',
      installedAt: new Date().toISOString(), enabled: false, trusted: 'untrusted', trustedAt: null,
    }
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: { 'gh-other': record } }), 'utf8')
    await rejectCode(new PluginRecordStore(file).load(), 'record/corrupt')
  })

  it('rejects a colon-carrying record map key as corruption', async () => {
    const file = join(tmp, 'colon.json')
    await writeFile(file, JSON.stringify({ schemaVersion: 1, records: { 'a:b': {} } }), 'utf8')
    await rejectCode(new PluginRecordStore(file).load(), 'record/corrupt')
  })
})

describe('PluginRecordStore atomic writes', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('records-atomic') })
  afterAll(async () => { await removeTmp(tmp) })

  it('persists through a temp file + rename and never writes the main file directly', async () => {
    const mainFile = join(tmp, 'plugins.json')
    const fs = new RecordingFs(NodeFs)
    const store = new PluginRecordStore(mainFile, { fs })
    await store.add({ key: key('gh-owner-repo'), source: githubSource, localDirName: 'gh-owner-repo' })
    await store.setEnabled(key('gh-owner-repo'), true)

    const writes = fs.ops.filter((op) => op.kind === 'write')
    const renames = fs.ops.filter((op) => op.kind === 'rename')
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(writes.every((op) => op.path.startsWith(`${mainFile}.tmp-`))).toBe(true)
    expect(writes.some((op) => op.path === mainFile)).toBe(false)
    for (const rename of renames) {
      expect(rename.to).toBe(mainFile)
      expect(rename.from.startsWith(`${mainFile}.tmp-`)).toBe(true)
    }

    const content = JSON.parse(await readFile(mainFile, 'utf8')) as { records: Record<string, { enabled: boolean }> }
    expect(content.records['gh-owner-repo']?.enabled).toBe(true)
    const leftover = (await readdir(tmp)).filter((name) => name.includes('.tmp-'))
    expect(leftover).toEqual([])
  })

  it('wraps a failed rename into record/io and cleans the temp file', async () => {
    const mainFile = join(tmp, 'fail.json')
    await writeFile(mainFile, JSON.stringify({ schemaVersion: 1, records: {} }), 'utf8')
    const fs = new RenameFailingFs(NodeFs)
    const store = new PluginRecordStore(mainFile, { fs })
    await rejectCode(
      store.add({ key: key('gh-owner-repo'), source: githubSource, localDirName: 'gh-owner-repo' }),
      'record/io',
    )
    const leftover = (await readdir(tmp)).filter((name) => name.includes('.tmp-'))
    expect(leftover).toEqual([])
  })
})

describe('PluginRecordStore (mock in-memory fs)', () => {
  it('supports CRUD with enabled=false defaults over a mock file system', async () => {
    const fs = new MemoryFs()
    await fs.mkdirp('/repo')
    const store = new PluginRecordStore('/repo/plugins.json', { fs })
    expect(await store.load()).toEqual([])
    const record = await store.add({ key: key('gh-owner-repo'), source: githubSource, localDirName: 'gh-owner-repo' })
    expect(record.enabled).toBe(false)
    expect(record.trusted).toBe('untrusted')
    await store.setTrusted(key('gh-owner-repo'), 'trusted')
    expect((await store.get(key('gh-owner-repo')))?.trusted).toBe('trusted')
    expect(await store.remove(key('gh-owner-repo'))).toBe(true)
    expect(await store.list()).toEqual([])
  })

  it('keeps a corrupted in-memory file untouched', async () => {
    const fs = new MemoryFs()
    await fs.mkdirp('/repo')
    const store = new PluginRecordStore('/repo/plugins.json', { fs })
    await fs.writeFile('/repo/plugins.json', 'garbage')
    await rejectCode(store.load(), 'record/corrupt')
    expect(await fs.readFile('/repo/plugins.json')).toBe('garbage')
  })
})

/** Records fs operations for atomic-write assertions. */
type Op =
  | { kind: 'write'; path: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'unlink'; path: string }

class RecordingFs implements FsLike {
  readonly ops: Op[] = []
  constructor(private readonly inner: FsLike = NodeFs) {}

  async lstat(path: string): Promise<FsStat | null> { return this.inner.lstat(path) }
  async stat(path: string): Promise<FsStat | null> { return this.inner.stat(path) }
  async readFile(path: string): Promise<string> { return this.inner.readFile(path) }
  async writeFile(path: string, data: string): Promise<void> {
    this.ops.push({ kind: 'write', path })
    return this.inner.writeFile(path, data)
  }
  async mkdirp(dir: string): Promise<void> { return this.inner.mkdirp(dir) }
  async readdir(dir: string): Promise<string[]> { return this.inner.readdir(dir) }
  async rename(from: string, to: string): Promise<void> {
    this.ops.push({ kind: 'rename', from, to })
    return this.inner.rename(from, to)
  }
  async unlink(path: string): Promise<void> {
    this.ops.push({ kind: 'unlink', path })
    return this.inner.unlink(path)
  }
  async rmrf(path: string): Promise<void> { return this.inner.rmrf(path) }
  async symlinkDir(target: string, link: string): Promise<void> { return this.inner.symlinkDir(target, link) }
  async realpath(path: string): Promise<string> { return this.inner.realpath(path) }
}

/** Delegating fs whose rename always fails (persist failure path). */
class RenameFailingFs extends RecordingFs {
  override async rename(from: string, to: string): Promise<void> {
    this.ops.push({ kind: 'rename', from, to })
    const error = new Error('rename denied') as NodeJS.ErrnoException
    error.code = 'EACCES'
    throw error
  }
}

describe('PluginRecordStore fail-fast input validation', () => {
  let tmp: string
  let filePath: string
  beforeAll(async () => {
    tmp = await makeSuiteTmp('records-validate')
    filePath = join(tmp, 'plugins.json')
  })
  afterAll(async () => { await removeTmp(tmp) })

  it('rejects a bad localDirName synchronously (record/invalid) and persists nothing', async () => {
    const store = new PluginRecordStore(filePath)
    await rejectCode(
      store.add({ key: key('gh-owner-repo'), source: githubSource, localDirName: 'a/b' }),
      'record/invalid',
    )
    // The bad value never lands: the file stays a clean empty document and a
    // later load does not misreport the whole file as corrupt.
    expect(await store.list()).toEqual([])
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { records: Record<string, unknown> }
    expect(raw.records).toEqual({})
  })

  it('rejects bad entry paths (record/invalid) and bad raw keys (record/key-invalid) up front', async () => {
    const store = new PluginRecordStore(filePath)
    for (const badEntry of ['../evil', 'a\\b', '/abs', '']) {
      await rejectCode(
        store.add({ key: key('gh-owner-repo'), source: githubSource, localDirName: 'gh-owner-repo', entry: badEntry }),
        'record/invalid',
      )
    }
    const badKey = 'a:b' as unknown as PluginMarketKey
    await rejectCode(
      store.add({ key: badKey, source: githubSource, localDirName: 'gh-owner-repo' }),
      'record/key-invalid',
    )
    expect(await store.list()).toEqual([])
  })

  it('accepts a valid entry and persists it for reload', async () => {
    const store = new PluginRecordStore(filePath)
    const record = await store.add({
      key: key('gh-owner-repo'),
      source: githubSource,
      localDirName: 'gh-owner-repo',
      entry: 'lib/index.js',
    })
    expect(record.entry).toBe('lib/index.js')
    expect((await new PluginRecordStore(filePath).get(key('gh-owner-repo')))?.entry).toBe('lib/index.js')
  })
})

describe('PluginRecordStore.register (add-or-replace for install updates)', () => {
  let tmp: string
  let filePath: string
  beforeAll(async () => {
    tmp = await makeSuiteTmp('records-register')
    filePath = join(tmp, 'plugins.json')
  })
  afterAll(async () => { await removeTmp(tmp) })

  it('registers a record with defaults and replaces it on a second register', async () => {
    const store = new PluginRecordStore(filePath)
    const first = await store.register({
      key: key('gh-owner-repo'), source: githubSource, localDirName: 'gh-owner-repo',
    })
    expect(first.enabled).toBe(false)
    expect(first.trusted).toBe('untrusted')
    const second = await store.register({
      key: key('gh-owner-repo'),
      source: githubSource,
      localDirName: 'gh-owner-repo-v2',
      entry: 'lib/main.js',
    })
    expect(second.localDirName).toBe('gh-owner-repo-v2')
    expect(second.entry).toBe('lib/main.js')
    expect((await store.list())).toHaveLength(1)
    expect((await store.get(key('gh-owner-repo')))?.localDirName).toBe('gh-owner-repo-v2')
  })

  it('stamps trusted + trustedAt when a confirmed install registers', async () => {
    const store = new PluginRecordStore(filePath)
    const record = await store.register({
      key: key('gh-owner-repo'), source: githubSource, localDirName: 'gh-owner-repo',
    }, { trusted: true })
    expect(record.enabled).toBe(false)
    expect(record.trusted).toBe('trusted')
    expect(record.trustedAt).not.toBeNull()
    expect((await new PluginRecordStore(filePath).get(key('gh-owner-repo')))?.trusted).toBe('trusted')
  })

  it('fail-fast validation applies to register too', async () => {
    const store = new PluginRecordStore(filePath)
    await rejectCode(
      store.register({ key: key('gh-owner-repo'), source: githubSource, localDirName: 'bad/name' }),
      'record/invalid',
    )
  })
})
