import type { ModelPrice } from '../domain/cost';

/** The prices of the PriceBook (architecture 5.3). Implemented in @smp/db. */
export interface PriceCatalog {
  /** The prices valid at an instant, per model. */
  pricesAt(at: Date): Promise<ReadonlyMap<string, ModelPrice>>;
}
