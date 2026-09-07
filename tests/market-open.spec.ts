import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PluginMarketSource } from '../src/types.ts'
import { MarketError } from '../src/host/market/errors.ts'
import { REQUIRED_HARNESS_PACKAGES } from '../src/host/market/harness.ts'
import { openMarketRepository } from '../src/host/market/index.ts'
import { parsePluginKey } from '../src/host/market/keys.ts'
import { repositoryConventionsPath, repositoryRecordsPath } from '../src/host/market/layout.ts'
import { RECORDS_SCHEMA_VERSION } from '../src/host/market/records.ts'
import { harnessShortName, scaffoldHostScope, scopeResolver } from './support/fake-harness.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

const githubSource: PluginMarketSource = {
  kind: 'github',
  repository: 'deepseek-ai/cordis',
  version: null,
  commit: null,
}

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

describe('openMarketRepository', () => {
  let tmp: string
  let hostScope: string
  beforeAll(async () => {
    tmp = await makeSuiteTmp('open')
    hostScope = await scaffoldHostScope(tmp, REQUIRED_HARNESS_PACKAGES)
  })
  afterAll(async () => { await removeTmp(tmp) })

  it('rejects a missing root with repository/not-exist', async () => {
    await rejectCode(
      openMarketRepository(join(tmp, 'missing')),
      'repository/not-exist',
    )
  })

  it('rejects a file path with repository/not-directory', async () => {
    const file = join(tmp, 'afile')
    await writeFile(file, 'x', 'utf8')
    await rejectCode(openMarketRepository(file), 'repository/not-directory')
  })

  it('creates a missing root with createIfMissing and initializes the full structure', async () => {
    const repo = join(tmp, 'created')
    const repository = await openMarketRepository(repo, {
      createIfMissing: true,
      resolver: scopeResolver(hostScope),
    })
    expect(repository.root).toBe(repo)

    // Records file v1 with defaults, and records usable end to end.
    const rawRecords = JSON.parse(await readFile(repositoryRecordsPath(repo), 'utf8')) as { schemaVersion: number; records: unknown }
    expect(rawRecords.schemaVersion).toBe(RECORDS_SCHEMA_VERSION)
    expect(rawRecords.records).toEqual({})
    const added = await repository.records.add({
      key: parsePluginKey('gh-owner-repo'),
      source: githubSource,
      localDirName: 'gh-owner-repo',
    })
    expect(added.enabled).toBe(false)
    expect(added.trusted).toBe('untrusted')

    // pnpm conventions recorded for the whole repository tree.
    const conventions = await readFile(repositoryConventionsPath(repo), 'utf8')
    expect(conventions).toContain('auto-install-peers=false')

    // Every required harness package is linked and single-instance verified.
    expect(repository.harnessLinks.links).toHaveLength(REQUIRED_HARNESS_PACKAGES.length)
    for (const name of REQUIRED_HARNESS_PACKAGES) {
      const linked = repository.harnessLinks.links.find((link) => link.name === name)
      expect(linked, name).toBeDefined()
      expect(linked?.target).toContain(harnessShortName(name))
    }
    expect(repository.harnessVerified?.singleInstance).toBe(true)

    // A second open over the ready repository stays idempotent.
    const again = await openMarketRepository(repo, { resolver: scopeResolver(hostScope) })
    await expect(again.records.list()).resolves.toHaveLength(1)
  })

  it('skips harness linking when linkSharedHarness is false', async () => {
    const repo = join(tmp, 'no-harness')
    await mkdir(repo)
    const repository = await openMarketRepository(repo, {
      resolver: scopeResolver(hostScope),
      linkSharedHarness: false,
    })
    expect(repository.harnessLinks.links).toEqual([])
    expect(repository.harnessVerified).toBeNull()
  })

  it('fails loudly on a corrupted records file and preserves its bytes', async () => {
    const repo = join(tmp, 'corrupt-repo')
    await openMarketRepository(repo, { createIfMissing: true, resolver: scopeResolver(hostScope) })
    await writeFile(repositoryRecordsPath(repo), 'garbage', 'utf8')
    await rejectCode(
      openMarketRepository(repo, { resolver: scopeResolver(hostScope) }),
      'record/corrupt',
    )
    expect(await readFile(repositoryRecordsPath(repo), 'utf8')).toBe('garbage')
  })
})
