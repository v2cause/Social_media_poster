import type { Clock } from '../../shared/ports/clock';
import { callCostMicros, estimateCostMicros, type CallCost, type ModelPrice } from '../domain/cost';
import type { AiCallReport } from '../domain/types';
import type { PriceCatalog } from '../ports/price-catalog';

// Costs of AI calls from the PriceBook (guide step 2.6): the estimate for the quota reservation
// before a call, the actual cost from the attempts of its report afterwards.

export interface CostCalculatorDependencies {
  prices: PriceCatalog;
  clock: Clock;
}

/**
 * The price of the model, or else the highest known price of every kind: a missing price must
 * never make a call cheaper.
 */
function priceOrHighest(prices: ReadonlyMap<string, ModelPrice>, model: string): ModelPrice {
  const own = prices.get(model);
  if (own) {
    return own;
  }
  const all = [...prices.values()];
  if (all.length === 0) {
    throw new Error('The price book has no prices.');
  }
  const highest = (field: keyof ModelPrice): bigint =>
    all.reduce((max, price) => (price[field] > max ? price[field] : max), 0n);
  return {
    inputMicrosPerMtok: highest('inputMicrosPerMtok'),
    outputMicrosPerMtok: highest('outputMicrosPerMtok'),
    cacheReadMicrosPerMtok: highest('cacheReadMicrosPerMtok'),
    cacheWrite5mMicrosPerMtok: highest('cacheWrite5mMicrosPerMtok'),
    cacheWrite1hMicrosPerMtok: highest('cacheWrite1hMicrosPerMtok'),
  };
}

export class CostCalculator {
  constructor(private readonly deps: CostCalculatorDependencies) {}

  /**
   * The cost of a finished call: every attempt at the price of the model that ran it. Attempts
   * of a model without a price count at the requested model's price (or the highest known one);
   * unpricedModels names them for a warning.
   */
  async costOf(report: Pick<AiCallReport, 'modelRequested' | 'attempts'>): Promise<CallCost> {
    const prices = await this.deps.prices.pricesAt(this.deps.clock.now());
    return callCostMicros(
      report.attempts,
      (model) => prices.get(model),
      priceOrHighest(prices, report.modelRequested),
    );
  }

  /** The estimate for the quota reservation, all input at the uncached price. */
  async estimateMicros(
    model: string,
    tokens: { inputTokens: number; outputTokens: number },
  ): Promise<bigint> {
    const prices = await this.deps.prices.pricesAt(this.deps.clock.now());
    return estimateCostMicros(tokens, priceOrHighest(prices, model));
  }
}
