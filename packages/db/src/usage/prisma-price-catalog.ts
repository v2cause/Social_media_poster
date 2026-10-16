import type { ModelPrice, PriceCatalog } from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';

// PriceCatalog on the price_book table (guide step 2.6). Prices change only through migrations,
// so the rows are cached for a few minutes. The table holds global reference data without a
// tenant and is readable for app_user without a context.

interface PriceRow extends ModelPrice {
  model: string;
  validFrom: Date;
}

export class PrismaPriceCatalog implements PriceCatalog {
  private cache: { loadedAt: number; rows: Promise<PriceRow[]> } | null = null;

  constructor(
    private readonly base: PrismaClient,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  async pricesAt(at: Date): Promise<ReadonlyMap<string, ModelPrice>> {
    const latest = new Map<string, PriceRow>();
    for (const row of await this.rows()) {
      const known = latest.get(row.model);
      if (row.validFrom <= at && (!known || row.validFrom > known.validFrom)) {
        latest.set(row.model, row);
      }
    }
    return new Map(
      [...latest].map(([model, row]) => [
        model,
        {
          inputMicrosPerMtok: row.inputMicrosPerMtok,
          outputMicrosPerMtok: row.outputMicrosPerMtok,
          cacheReadMicrosPerMtok: row.cacheReadMicrosPerMtok,
          cacheWrite5mMicrosPerMtok: row.cacheWrite5mMicrosPerMtok,
          cacheWrite1hMicrosPerMtok: row.cacheWrite1hMicrosPerMtok,
        },
      ]),
    );
  }

  private rows(): Promise<PriceRow[]> {
    // A monotonic clock for the cache only; the validity of prices uses the caller's instant.
    const now = performance.now();
    if (!this.cache || now - this.cache.loadedAt > this.ttlMs) {
      const rows = this.base.priceBook.findMany({
        select: {
          model: true,
          validFrom: true,
          inputMicrosPerMtok: true,
          outputMicrosPerMtok: true,
          cacheReadMicrosPerMtok: true,
          cacheWrite5mMicrosPerMtok: true,
          cacheWrite1hMicrosPerMtok: true,
        },
      });
      const cache = { loadedAt: now, rows };
      this.cache = cache;
      // A failed load is not cached; the next call tries again.
      rows.catch(() => {
        if (this.cache === cache) {
          this.cache = null;
        }
      });
    }
    return this.cache.rows;
  }
}
