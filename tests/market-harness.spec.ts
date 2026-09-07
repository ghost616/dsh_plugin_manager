import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import { NodeFs } from '../src/host/market/fs.ts'
import { REQUIRED_HARNESS_PACKAGES, SharedHarnessLinker } from '../src/host/market/harness.ts'
import { harnessShortName, scaffoldHostScope, scopeResolver } from './support/fake-harness.ts'
import { makeSuiteTmp, removeTmp } from './support/tmpdir.ts'

describe('SharedHarnessLinker', () => {
  let tmp: string
  beforeAll(async () => { tmp = await makeSuiteTmp('harness') })
  afterAll(async () => { await removeTmp(tmp) })

  it('links every required package into the shared scope at the running instance', async () => {
    // Every case scaffolds into its own host dir so no case leaks packages
    // into another case's "missing package" fixture.
    const scope = await scaffoldHostScope(join(tmp, 'case-1'), REQUIRED_HARNESS_PACKAGES)
    const root = join(tmp, 'repo-1')
    await mkdir(root)
    const linker = new SharedHarnessLinker({ resolver: scopeResolver(scope) })
    const result = await linker.ensure(root)
    expect(result.links).toHaveLength(REQUIRED_HARNESS_PACKAGES.length)
    for (const link of result.links) {
      expect(link.created).toBe(true)
      expect(await NodeFs.realpath(link.linkPath))
        .toBe(await NodeFs.realpath(join(scope, harnessShortName(link.name))))
    }
  })

  it('is idempotent: a second ensure keeps existing correct links', async () => {
    const scope = await scaffoldHostScope(join(tmp, 'case-2'), REQUIRED_HARNESS_PACKAGES)
    const root = join(tmp, 'repo-2')
    await mkdir(root)
    const linker = new SharedHarnessLinker({ resolver: scopeResolver(scope) })
    await linker.ensure(root)
    const second = await linker.ensure(root)
    expect(second.links).toHaveLength(REQUIRED_HARNESS_PACKAGES.length)
    expect(second.links.every((link) => !link.created)).toBe(true)
  })

  it('lets a nested plugin checkout resolve @deepseek-ai/* upward to the same instance', async () => {
    const scope = await scaffoldHostScope(join(tmp, 'case-3'), REQUIRED_HARNESS_PACKAGES)
    const root = join(tmp, 'repo-3')
    await mkdir(root)
    const linker = new SharedHarnessLinker({ resolver: scopeResolver(scope) })
    await linker.ensure(root)

    // A downloaded plugin checkout sits under the repository root without its
    // own harness deps; Node resolution must climb into the shared scope.
    const checkout = join(root, 'gh-owner-repo')
    await mkdir(checkout)
    const require = createRequire(join(checkout, '__probe__.js'))
    const resolvedEntry = require.resolve('@deepseek-ai/cordis')
    const expectedRoot = join(scope, 'cordis')
    // require.resolve lands on the package main file; its parent is the root.
    expect(dirname(resolvedEntry)).toBe(expectedRoot)

    // The verify step sees the same physical instance from the repo root.
    const verification = await linker.verify(root)
    expect(verification.singleInstance).toBe(true)
    expect(verification.entries).toHaveLength(REQUIRED_HARNESS_PACKAGES.length)
    for (const entry of verification.entries) {
      expect(entry.sameInstance).toBe(true)
      expect(entry.target).toBe(await NodeFs.realpath(join(scope, harnessShortName(entry.name))))
    }
  })

  it('skips optional packages the running instance does not provide', async () => {
    const scope = await scaffoldHostScope(join(tmp, 'case-4'), REQUIRED_HARNESS_PACKAGES)
    const root = join(tmp, 'repo-4')
    await mkdir(root)
    const linker = new SharedHarnessLinker({ resolver: scopeResolver(scope) })
    const result = await linker.ensure(root)
    expect(result.links).toHaveLength(REQUIRED_HARNESS_PACKAGES.length)
  })

  it('fails loudly with harness/resolve-failed when a required package is missing', async () => {
    // Case-isolated host dir containing only two of the three required
    // packages, so dsh-typert-protocol is genuinely absent.
    const partial = REQUIRED_HARNESS_PACKAGES.slice(0, 2)
    const scope = await scaffoldHostScope(join(tmp, 'case-5'), partial)
    const root = join(tmp, 'repo-5')
    await mkdir(root)
    const linker = new SharedHarnessLinker({ resolver: scopeResolver(scope) })
    try {
      await linker.ensure(root)
      throw new Error('expected harness/resolve-failed')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('harness/resolve-failed')
    }
  })

  it('fails with harness/link-conflict when a conflicting entry occupies the link path', async () => {
    const scope = await scaffoldHostScope(join(tmp, 'case-6'), REQUIRED_HARNESS_PACKAGES)
    const root = join(tmp, 'repo-6')
    await mkdir(root)
    // Occupying directory named exactly like the cordis link target.
    await mkdir(join(root, 'node_modules', '@deepseek-ai', 'cordis'), { recursive: true })
    const linker = new SharedHarnessLinker({ resolver: scopeResolver(scope) })
    try {
      await linker.ensure(root)
      throw new Error('expected harness/link-conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('harness/link-conflict')
    }
  })

  it('reports singleInstance=false when the consumer resolves elsewhere', async () => {
    const scope = await scaffoldHostScope(join(tmp, 'case-7'), REQUIRED_HARNESS_PACKAGES)
    const otherScope = await scaffoldHostScope(join(tmp, 'case-7-other'), REQUIRED_HARNESS_PACKAGES)
    const root = join(tmp, 'repo-7')
    await mkdir(root)
    const linker = new SharedHarnessLinker({ resolver: scopeResolver(scope) })
    await linker.ensure(root)
    const verifying = new SharedHarnessLinker({
      resolver: scopeResolver(scope),
      consumer: async () => await NodeFs.realpath(join(otherScope, 'cordis')),
      requiredPackages: ['@deepseek-ai/cordis'],
    })
    const result = await verifying.verify(root)
    expect(result.singleInstance).toBe(false)
    expect(result.entries[0]?.sameInstance).toBe(false)
  })
})
