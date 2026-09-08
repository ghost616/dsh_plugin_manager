import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  MARKET_CONFIG_DEFAULTS,
  MarketRepositoryService,
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
