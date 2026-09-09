import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  GITHUB_LIST_MAX_PAGES,
  GITHUB_LIST_PAGE_SIZE,
  MARKET_CONFIG_DEFAULTS,
  MarketRepositoryService,
  GitHubMarket,
  isManagedLocalDirName,
  parseRefSeg,
  parsePluginKey,
  pluginKeyForGithubRef,
  refSegOf,
  resolveInstallTarget,
  normalizeMarketConfig,
  openMarketRepository,
} from '../src/host/market/index.ts'
import { MarketError } from '../src/host/market/errors.ts'

/**
 * Guards the single-import reuse surface the framework composer consumes:
 * openMarketRepository + normalizeMarketConfig + MarketRepositoryService
 * (plus the Config type, verified at compile time by tsc on the host leaf).
 */
describe('plugin-market-host public export surface', () => {
  it('exposes the reusable activation pieces from the market index', () => {
    expect(typeof openMarketRepository).toBe('function')
    expect(typeof normalizeMarketConfig).toBe('function')
    expect(typeof MarketRepositoryService).toBe('function')
  })

  it('re-exports the GitHubMarket class and ref-listing page constants', () => {
    expect(typeof GitHubMarket).toBe('function')
    expect(GITHUB_LIST_PAGE_SIZE).toBe(100)
    expect(GITHUB_LIST_MAX_PAGES).toBe(5)
  })

  it('re-exports the v2 directory/key helpers from the market index', () => {
    expect(typeof parsePluginKey).toBe('function')
    expect(typeof pluginKeyForGithubRef).toBe('function')
    expect(typeof refSegOf).toBe('function')
    expect(typeof parseRefSeg).toBe('function')
    expect(typeof isManagedLocalDirName).toBe('function')
    expect(typeof resolveInstallTarget).toBe('function')
    const key = pluginKeyForGithubRef('owner/repo', 'branch', 'main')
    expect(key).toBe(parsePluginKey(key))
    expect(parseRefSeg(refSegOf('feature/x'))).toBe('feature/x')
    expect(isManagedLocalDirName('owner/repo/branch/main')).toBe(true)
    expect(isManagedLocalDirName('gh-owner-repo')).toBe(true)
  })

  it('keeps activation defaults: createIfMissing=false, harness linking on', () => {
    expect(MARKET_CONFIG_DEFAULTS.createIfMissing).toBe(false)
    expect(MARKET_CONFIG_DEFAULTS.linkSharedHarness).toBe(true)
  })

  it('keeps stable error behavior through the surface (config/invalid)', () => {
    const env = { cwd: process.cwd(), home: homedir() }
    try {
      normalizeMarketConfig({ repositoryPath: 42 }, env)
      throw new Error('expected config/invalid')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('config/invalid')
    }
  })
})
