import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_OUTPUT_MAX_LENGTH,
  ANALYSIS_REASON_MAX_LENGTH,
  GITHUB_LIST_MAX_PAGES,
  GITHUB_LIST_PAGE_SIZE,
  MARKET_CONFIG_DEFAULTS,
  MarketRepositoryService,
  GitHubMarket,
  InstallAnalyzer,
  README_CANDIDATES,
  SNAPSHOT_ENTRY_LIMIT,
  buildAnalyzePrompt,
  collectCheckoutSnapshot,
  isManagedLocalDirName,
  parseAnalysisOutput,
  parseRefSeg,
  parsePluginKey,
  pluginKeyForGithubRef,
  probeCheckoutEntry,
  refSegOf,
  requireMarketLlm,
  resolveAnalysisDistribution,
  resolveAnalysisVerdict,
  resolveInstallTarget,
  normalizeMarketConfig,
  openMarketRepository,
} from '../src/host/market/index.ts'
import { MarketError } from '../src/host/market/errors.ts'
import {
  DEFAULT_PLUGIN_MARKET_CLASSIFICATION,
  isPluginMarketClassification,
} from '../src/types.ts'

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
    expect(parseRefSeg(refSegOf('feature/x') ?? '')).toBe('feature/x')
    expect(isManagedLocalDirName('owner/repo/branch/main')).toBe(true)
    expect(isManagedLocalDirName('gh-owner-repo')).toBe(true)
  })

  it('keeps activation defaults: createIfMissing=false, harness linking on', () => {
    expect(MARKET_CONFIG_DEFAULTS.createIfMissing).toBe(false)
    expect(MARKET_CONFIG_DEFAULTS.linkSharedHarness).toBe(true)
  })

  it('keeps stable error behavior through the surface (config/invalid)', () => {
    // os.homedir() types as `string | null` under @types/node; an empty home
    // keeps the fixture's path expansion deterministic.
    const env = { cwd: process.cwd(), home: homedir() ?? '' }
    try {
      normalizeMarketConfig({ repositoryPath: 42 }, env)
      throw new Error('expected config/invalid')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('config/invalid')
    }
  })

  it('exposes the smart-install analyzer pieces from the market index', () => {
    expect(typeof InstallAnalyzer).toBe('function')
    expect(typeof collectCheckoutSnapshot).toBe('function')
    expect(typeof buildAnalyzePrompt).toBe('function')
    expect(typeof parseAnalysisOutput).toBe('function')
    expect(typeof resolveAnalysisVerdict).toBe('function')
    expect(typeof probeCheckoutEntry).toBe('function')
    expect(typeof requireMarketLlm).toBe('function')
    expect(README_CANDIDATES[0]).toBe('README')
    expect(SNAPSHOT_ENTRY_LIMIT).toBeGreaterThan(0)
    expect(ANALYSIS_REASON_MAX_LENGTH).toBeGreaterThan(0)
    expect(ANALYSIS_OUTPUT_MAX_LENGTH).toBeGreaterThan(ANALYSIS_REASON_MAX_LENGTH)
  })

  it('classifies instead of refusing through the analyzer surface', () => {
    expect(resolveAnalysisDistribution).toBe(resolveAnalysisVerdict)
    expect(resolveAnalysisDistribution({ kind: 'skills', reason: 'a skills pack', entryHint: null })).toMatchObject({
      classification: 'skills',
      entry: null,
      reason: 'a skills pack',
    })
    expect(resolveAnalysisDistribution({ kind: 'preset', reason: 'a preset', entryHint: null }).classification).toBe('other')
    expect(resolveAnalysisDistribution({ kind: 'plugin', reason: 'plugin', entryHint: 'index.js' }).classification).toBe('plugin')
    // The classification tag vocabulary is shared with the record store.
    expect(DEFAULT_PLUGIN_MARKET_CLASSIFICATION).toBe('plugin')
    expect(isPluginMarketClassification('skills')).toBe(true)
    expect(isPluginMarketClassification('preset')).toBe(false)
  })

  it('keeps stable error behavior through the surface (market/llm-unconfigured)', () => {
    try {
      requireMarketLlm(undefined, undefined)
      throw new Error('expected market/llm-unconfigured')
    } catch (error) {
      expect(error).toBeInstanceOf(MarketError)
      expect((error as MarketError).code).toBe('market/llm-unconfigured')
    }
  })
})
