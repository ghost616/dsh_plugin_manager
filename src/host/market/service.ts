/**
 * Cordis service exposing an opened plugin source repository to consumer rows
 * (the market control row) of this package. The plugin-market-host row opens
 * the repository once and provides this service; consumers react to its
 * presence through `ctx.inject(['marketRepository', ...])`, so the repository
 * is never opened twice and a misconfigured (idle) market simply never
 * provides the service.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { MarketRepository } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The opened plugin source repository, when plugin-market-host configured one. */
    marketRepository: MarketRepositoryService
  }
}

/** One opened plugin source repository as a Cordis service. */
export class MarketRepositoryService extends Service {
  readonly repository: MarketRepository

  constructor(ctx: Context, repository: MarketRepository) {
    super(ctx, 'marketRepository')
    this.repository = repository
  }
}

export default MarketRepositoryService