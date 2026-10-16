import type { AiAttempt } from './types';

// Cost of AI calls in micro-USD (architecture 6.1: money as integers). Prices come from the
// PriceBook, never from code. Every attempt is billed at the price of the model that ran it;
// the top-level usage of a response covers only the attempt that answered (ADR 0007).

/** Prices of one model in micro-USD per million tokens. */
export interface ModelPrice {
  inputMicrosPerMtok: bigint;
  outputMicrosPerMtok: bigint;
  cacheReadMicrosPerMtok: bigint;
  cacheWrite5mMicrosPerMtok: bigint;
  cacheWrite1hMicrosPerMtok: bigint;
}

const PER_MTOK = 1_000_000n;

/** The cost of one attempt, rounded up to a whole micro-USD. */
export function attemptCostMicros(attempt: AiAttempt, price: ModelPrice): bigint {
  const total =
    BigInt(attempt.inputTokens) * price.inputMicrosPerMtok +
    BigInt(attempt.outputTokens) * price.outputMicrosPerMtok +
    BigInt(attempt.cacheReadTokens) * price.cacheReadMicrosPerMtok +
    BigInt(attempt.cacheWrite5mTokens) * price.cacheWrite5mMicrosPerMtok +
    BigInt(attempt.cacheWrite1hTokens) * price.cacheWrite1hMicrosPerMtok;
  return (total + PER_MTOK - 1n) / PER_MTOK;
}

export interface CallCost {
  costMicros: bigint;
  /** Models without a price; their attempts were billed at the fallback price. */
  unpricedModels: string[];
}

/**
 * The cost of all attempts of a call. An attempt whose model has no price is billed at the
 * fallback price (the requested model's), so a missing price never makes a call free.
 */
export function callCostMicros(
  attempts: readonly AiAttempt[],
  priceOf: (model: string) => ModelPrice | undefined,
  fallbackPrice: ModelPrice,
): CallCost {
  let costMicros = 0n;
  const unpricedModels = new Set<string>();
  for (const attempt of attempts) {
    const price = priceOf(attempt.model);
    if (!price) {
      unpricedModels.add(attempt.model);
    }
    costMicros += attemptCostMicros(attempt, price ?? fallbackPrice);
  }
  return { costMicros, unpricedModels: [...unpricedModels] };
}

/** An upper estimate before the call, for the quota reservation (guide step 2.6). */
export function estimateCostMicros(
  estimate: { inputTokens: number; outputTokens: number },
  price: ModelPrice,
): bigint {
  return attemptCostMicros(
    {
      kind: 'message',
      model: '',
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
    price,
  );
}
