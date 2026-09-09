import { describe, expect, it } from 'vitest'
import { MarketError } from '../src/host/market/errors.ts'
import {
  isValidPluginKey,
  parsePluginKey,
  pluginKeyForGithubRef,
  PLUGIN_MARKET_KEY_MAX_LENGTH,
} from '../src/host/market/keys.ts'

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

describe('pluginKeyForGithubRef (per-owner/repo/kind/ref keys)', () => {
  it('derives a deterministic key unique to the ref tuple', () => {
    const branch = pluginKeyForGithubRef('owner/sample-plugin', 'branch', 'main')
    const tag = pluginKeyForGithubRef('owner/sample-plugin', 'tag', 'main')
    const otherBranch = pluginKeyForGithubRef('owner/sample-plugin', 'branch', 'dev')
    const otherRepo = pluginKeyForGithubRef('other/sample-plugin', 'branch', 'main')
    expect(pluginKeyForGithubRef('owner/sample-plugin', 'branch', 'main')).toBe(branch)
    expect(branch).not.toBe(tag)
    expect(branch).not.toBe(otherBranch)
    expect(branch).not.toBe(otherRepo)
  })

  it('keeps keys valid, path-safe and bounded', () => {
    for (const key of [
      pluginKeyForGithubRef('owner/sample-plugin', 'branch', 'main'),
      pluginKeyForGithubRef('o-r/x', 'tag', 'v1.2.3'),
      // A slash-heavy branch name encodes into the key without separators.
      pluginKeyForGithubRef('owner/repo', 'branch', 'feature/very/deep'),
    ]) {
      expect(isValidPluginKey(key)).toBe(true)
      expect(key.length).toBeLessThanOrEqual(PLUGIN_MARKET_KEY_MAX_LENGTH)
      expect(key).not.toMatch(/[:/\\\s]/)
      expect(key).not.toBe('.')
      expect(key).not.toBe('..')
    }
  })

  it('rejects a malformed slug via github/bad-request', () => {
    try {
      pluginKeyForGithubRef('not-a-slug', 'branch', 'main')
      throw new Error('expected a MarketError')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('github/bad-request')
    }
  })

  it('falls back to a bounded digest key for oversized readable tuples', () => {
    const longOwner = 'o'.repeat(40)
    const longRepo = 'r'.repeat(60)
    const key = pluginKeyForGithubRef(`${longOwner}/${longRepo}`, 'branch', 'main')
    expect(isValidPluginKey(key)).toBe(true)
    expect(key.length).toBeLessThanOrEqual(PLUGIN_MARKET_KEY_MAX_LENGTH)
  })
})
