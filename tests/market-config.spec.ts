import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeMarketConfig } from '../src/host/market/config.ts'
import { MarketError } from '../src/host/market/errors.ts'

const env = { cwd: process.cwd(), home: homedir() }

/** Assert that `fn` throws a MarketError with the given stable code. */
function expectMarketError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(MarketError)
    expect((error as MarketError).code).toBe(code)
    return
  }
  throw new Error(`expected MarketError with code ${code}, but nothing was thrown`)
}

describe('normalizeMarketConfig', () => {
  it('returns null repositoryPath when unset', () => {
    for (const input of [undefined, null, {}, { repositoryPath: undefined }]) {
      expect(normalizeMarketConfig(input, env).repositoryPath).toBeNull()
    }
  })

  it('treats blank repositoryPath as unset', () => {
    for (const input of [{ repositoryPath: '' }, { repositoryPath: '   ' }]) {
      expect(normalizeMarketConfig(input, env).repositoryPath).toBeNull()
    }
  })

  it('throws config/invalid for a non-string repositoryPath', () => {
    expectMarketError(() => normalizeMarketConfig({ repositoryPath: 42 }, env), 'config/invalid')
    expectMarketError(() => normalizeMarketConfig({ repositoryPath: [] }, env), 'config/invalid')
    expectMarketError(() => normalizeMarketConfig('nope', env), 'config/invalid')
  })

  it('resolves a relative path against the working directory', () => {
    const result = normalizeMarketConfig({ repositoryPath: 'relative/repo' }, env)
    expect(result.repositoryPath).toBe(resolve(env.cwd, 'relative/repo'))
  })

  it('expands a leading ~ against the home directory', () => {
    expect(normalizeMarketConfig({ repositoryPath: '~' }, env).repositoryPath).toBe(homedir())
    expect(normalizeMarketConfig({ repositoryPath: '~/repos/third-party' }, env).repositoryPath)
      .toBe(join(homedir(), 'repos', 'third-party'))
  })

  it('keeps an absolute path and normalizes it', () => {
    const input = resolve(env.cwd, '..', 'somewhere', '..', 'repo')
    expect(normalizeMarketConfig({ repositoryPath: input }, env).repositoryPath)
      .toBe(resolve(input))
  })

  it('applies activation defaults and ignores unknown fields', () => {
    const result = normalizeMarketConfig({ repositoryPath: 'x', futureOption: 1 }, env)
    expect(result.createIfMissing).toBe(false)
    expect(result.linkSharedHarness).toBe(true)
    expect(result.repositoryPath).toBe(resolve(env.cwd, 'x'))
  })
})
