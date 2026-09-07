import { describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import { isValidPluginKey, parsePluginKey, PLUGIN_MARKET_KEY_MAX_LENGTH } from '../src/host/market/keys.ts'

describe('plugin-market stable keys', () => {
  it('accepts GitHub-style keys like gh-owner-repo', () => {
    expect(parsePluginKey('gh-owner-repo')).toBe('gh-owner-repo')
    expect(isValidPluginKey('gh-owner-repo')).toBe(true)
  })

  it('accepts dots and underscores (still path-safe, no colon)', () => {
    expect(parsePluginKey('my_plugin.v2')).toBe('my_plugin.v2')
  })

  it('rejects the loader-forbidden colon', () => {
    expect(isValidPluginKey('a:b')).toBe(false)
    expect(() => parsePluginKey('a:b')).toThrow(MarketError)
  })

  it('rejects whitespace and path separators', () => {
    for (const bad of ['a b', 'a/b', 'a\\b']) {
      expect(isValidPluginKey(bad), bad).toBe(false)
    }
  })

  it('rejects empty, dot and dot-dot keys', () => {
    for (const bad of ['', '.', '..']) {
      expect(isValidPluginKey(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('rejects over-long keys', () => {
    const long = 'k'.repeat(PLUGIN_MARKET_KEY_MAX_LENGTH + 1)
    expect(isValidPluginKey(long)).toBe(false)
    const boundary = 'k'.repeat(PLUGIN_MARKET_KEY_MAX_LENGTH)
    expect(isValidPluginKey(boundary)).toBe(true)
  })

  it('throws record/key-invalid with an actionable message', () => {
    try {
      parsePluginKey('has:colon')
      throw new Error('expected a MarketError')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('record/key-invalid')
    }
  })
})
