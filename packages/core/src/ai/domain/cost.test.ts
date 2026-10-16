import { describe, expect, it } from 'vitest';

import { attemptCostMicros, callCostMicros, estimateCostMicros, type ModelPrice } from './cost';
import type { AiAttempt } from './types';

// Prices of the price book (migration reference_data), in micro-USD per million tokens.
const OPUS_5_5: ModelPrice = {
  inputMicrosPerMtok: 4_000_000n,
  outputMicrosPerMtok: 20_000_000n,
  cacheReadMicrosPerMtok: 200_000n,
  cacheWrite5mMicrosPerMtok: 5_000_000n,
  cacheWrite1hMicrosPerMtok: 8_000_000n,
};
const OPUS_4_8: ModelPrice = {
  inputMicrosPerMtok: 5_000_000n,
  outputMicrosPerMtok: 25_000_000n,
  cacheReadMicrosPerMtok: 500_000n,
  cacheWrite5mMicrosPerMtok: 6_250_000n,
  cacheWrite1hMicrosPerMtok: 10_000_000n,
};

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

describe('attemptCostMicros', () => {
  it('prices every token category', () => {
    // 1,000 input (4,000) + 2,000 output (40,000) + 10,000 cache reads (2,000)
    // + 3,000 cache writes of 5 minutes (15,000) + 1,000 of 1 hour (8,000) micro-USD.
    expect(
      attemptCostMicros(
        attempt({
          inputTokens: 1000,
          outputTokens: 2000,
          cacheReadTokens: 10_000,
          cacheWrite5mTokens: 3000,
          cacheWrite1hTokens: 1000,
        }),
        OPUS_5_5,
      ),
    ).toBe(69_000n);
  });

  it('rounds up to a whole micro-USD', () => {
    expect(attemptCostMicros(attempt({ cacheReadTokens: 1 }), OPUS_5_5)).toBe(1n);
    expect(attemptCostMicros(attempt({}), OPUS_5_5)).toBe(0n);
  });
});

describe('callCostMicros', () => {
  it('bills a declined attempt and the fallback attempt at the price of their models', () => {
    const cost = callCostMicros(
      [
        attempt({ inputTokens: 1000, outputTokens: 100 }),
        attempt({ kind: 'fallback_message', model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 500 }),
      ],
      (model) => ({ 'claude-opus-5-5': OPUS_5_5, 'claude-opus-4-8': OPUS_4_8 })[model],
      OPUS_5_5,
    );
    // 4,000 + 2,000 for the declined attempt, 5,000 + 12,500 for the fallback.
    expect(cost).toEqual({ costMicros: 23_500n, unpricedModels: [] });
  });

  it('bills a model without a price at the fallback price and reports it', () => {
    const cost = callCostMicros(
      [attempt({ model: 'claude-future-1', outputTokens: 1000 })],
      () => undefined,
      OPUS_5_5,
    );
    expect(cost).toEqual({ costMicros: 20_000n, unpricedModels: ['claude-future-1'] });
  });
});

describe('estimateCostMicros', () => {
  it('prices the estimated input and output tokens', () => {
    expect(estimateCostMicros({ inputTokens: 5000, outputTokens: 4000 }, OPUS_5_5)).toBe(100_000n);
  });
});
