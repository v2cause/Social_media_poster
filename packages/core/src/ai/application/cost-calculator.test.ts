import { describe, expect, it } from 'vitest';

import type { ModelPrice } from '../domain/cost';
import type { AiAttempt } from '../domain/types';
import type { PriceCatalog } from '../ports/price-catalog';
import { CostCalculator } from './cost-calculator';

// Prices per million tokens in micro-USD, as in the price book of 2026-10-16.
const price = (
  input: bigint,
  output: bigint,
  cacheRead: bigint,
  write5m: bigint,
  write1h: bigint,
): ModelPrice => ({
  inputMicrosPerMtok: input,
  outputMicrosPerMtok: output,
  cacheReadMicrosPerMtok: cacheRead,
  cacheWrite5mMicrosPerMtok: write5m,
  cacheWrite1hMicrosPerMtok: write1h,
});
const OPUS_5_5 = price(4_000_000n, 20_000_000n, 200_000n, 5_000_000n, 8_000_000n);
const OPUS_5 = price(5_000_000n, 25_000_000n, 500_000n, 6_250_000n, 10_000_000n);

const catalog = (prices: Record<string, ModelPrice>): PriceCatalog & { seen: Date[] } => {
  const seen: Date[] = [];
  return {
    seen,
    pricesAt: (at) => {
      seen.push(at);
      return Promise.resolve(new Map(Object.entries(prices)));
    },
  };
};

const now = new Date('2026-10-16T12:00:00Z');
const calculator = (prices: PriceCatalog) => new CostCalculator({ prices, clock: { now: () => now } });

const attempt = (overrides: Partial<AiAttempt>): AiAttempt => ({
  kind: 'message',
  model: 'claude-opus-5-5',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...overrides,
});

describe('CostCalculator', () => {
  it('bills every attempt at the price of its model, valid now', async () => {
    const prices = catalog({ 'claude-opus-5-5': OPUS_5_5, 'claude-opus-5': OPUS_5 });

    const cost = await calculator(prices).costOf({
      modelRequested: 'claude-opus-5-5',
      attempts: [
        // The declined attempt: 1000 input + 2000 cache read + 100 output at Opus 5.5.
        attempt({ inputTokens: 1_000, cacheReadTokens: 2_000, outputTokens: 100 }),
        // The fallback that answered: 1000 input + 500 output at Opus 5.
        attempt({ kind: 'fallback_message', model: 'claude-opus-5', inputTokens: 1_000, outputTokens: 500 }),
      ],
    });

    // 4000 + 400 + 2000 = 6400 micro-USD, then 5000 + 12500 = 17500 micro-USD.
    expect(cost).toEqual({ costMicros: 23_900n, unpricedModels: [] });
    expect(prices.seen).toEqual([now]);
  });

  it('bills a model without a price at the requested price and names it', async () => {
    const cost = await calculator(catalog({ 'claude-opus-5-5': OPUS_5_5 })).costOf({
      modelRequested: 'claude-opus-5-5',
      attempts: [attempt({ model: 'claude-unknown', outputTokens: 1_000 })],
    });

    expect(cost).toEqual({ costMicros: 20_000n, unpricedModels: ['claude-unknown'] });
  });

  it('bills at the highest known prices when even the requested model has no price', async () => {
    const prices = catalog({ 'claude-opus-5-5': OPUS_5_5, 'claude-opus-5': OPUS_5 });

    const cost = await calculator(prices).costOf({
      modelRequested: 'claude-next',
      attempts: [attempt({ model: 'claude-next', inputTokens: 1_000, outputTokens: 1_000 })],
    });
    const estimate = await calculator(prices).estimateMicros('claude-next', {
      inputTokens: 1_000,
      outputTokens: 1_000,
    });

    expect(cost.costMicros).toBe(30_000n);
    expect(estimate).toBe(30_000n);
  });

  it('estimates all input at the uncached price', async () => {
    const estimate = await calculator(catalog({ 'claude-opus-5-5': OPUS_5_5 })).estimateMicros(
      'claude-opus-5-5',
      {
        inputTokens: 3_000,
        outputTokens: 4_000,
      },
    );

    expect(estimate).toBe(92_000n);
  });

  it('fails loudly when the price book is empty', async () => {
    await expect(
      calculator(catalog({})).costOf({ modelRequested: 'claude-opus-5-5', attempts: [attempt({})] }),
    ).rejects.toThrow('The price book has no prices.');
  });
});
