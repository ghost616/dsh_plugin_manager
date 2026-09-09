import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeMarketConfig, requireMarketLlm } from '../src/host/market/config.ts'
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
    expect(result.llm).toBeUndefined()
  })

  it('leaves llm unset when the raw config carries no llm section', () => {
    for (const input of [undefined, {}, { llm: undefined }, { llm: null }, { llm: {} }, { llm: { provider: '  ', model: '  ' } }]) {
      expect(normalizeMarketConfig(input, env).llm).toBeUndefined()
    }
  })

  it('normalizes a valid llm section (trims provider/model)', () => {
    const result = normalizeMarketConfig({ llm: { provider: '  ds-provider ', model: 'deepseek-chat ' } }, env)
    expect(result.llm).toEqual({ provider: 'ds-provider', model: 'deepseek-chat' })
  })

  it('keeps a partial llm section with only the fields provided', () => {
    const onlyProvider = normalizeMarketConfig({ llm: { provider: 'ds-provider' } }, env)
    expect(onlyProvider.llm?.provider).toBe('ds-provider')
    expect(onlyProvider.llm?.model).toBeUndefined()
    const onlyModel = normalizeMarketConfig({ llm: { model: 'deepseek-chat' } }, env)
    expect(onlyModel.llm?.model).toBe('deepseek-chat')
    expect(onlyModel.llm?.provider).toBeUndefined()
  })

  it('rejects malformed llm sections with config/invalid', () => {
    expectMarketError(() => normalizeMarketConfig({ llm: 'deepseek' }, env), 'config/invalid')
    expectMarketError(() => normalizeMarketConfig({ llm: ['ds'] }, env), 'config/invalid')
    expectMarketError(() => normalizeMarketConfig({ llm: { provider: 42 } }, env), 'config/invalid')
    expectMarketError(() => normalizeMarketConfig({ llm: { model: [] } }, env), 'config/invalid')
    expectMarketError(() => normalizeMarketConfig({ llm: { provider: null, model: {} } }, env), 'config/invalid')
  })
})

describe('requireMarketLlm', () => {
  it('resolves a complete provider/model endpoint', () => {
    expect(requireMarketLlm(' ds-provider ', ' deepseek-chat '))
      .toEqual({ provider: 'ds-provider', model: 'deepseek-chat' })
  })

  it('throws market/llm-unconfigured when provider or model is missing', () => {
    expectMarketError(() => requireMarketLlm(undefined, undefined), 'market/llm-unconfigured')
    expectMarketError(() => requireMarketLlm('ds-provider', undefined), 'market/llm-unconfigured')
    expectMarketError(() => requireMarketLlm(undefined, 'deepseek-chat'), 'market/llm-unconfigured')
    expectMarketError(() => requireMarketLlm('  ', 'deepseek-chat'), 'market/llm-unconfigured')
    expectMarketError(() => requireMarketLlm('ds-provider', ''), 'market/llm-unconfigured')
  })
})
