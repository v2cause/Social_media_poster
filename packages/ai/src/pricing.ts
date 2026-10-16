import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiAttempt } from '@smp/core';

// Usage of a response, normalized to one entry per attempt (ADR 0007). usage.iterations is
// the per-attempt record: a declined attempt appears as "message", the fallback model that
// answered as "fallback_message". The top-level usage covers only the attempt that answered.
// Costs are computed from these attempts with the price book (@smp/core, callCostMicros).

type Iteration = NonNullable<BetaUsage['iterations']>[number];

const cacheWrites = (
  usage: Pick<BetaUsage, 'cache_creation' | 'cache_creation_input_tokens'>,
): { cacheWrite5mTokens: number; cacheWrite1hTokens: number } =>
  usage.cache_creation
    ? {
        cacheWrite5mTokens: usage.cache_creation.ephemeral_5m_input_tokens,
        cacheWrite1hTokens: usage.cache_creation.ephemeral_1h_input_tokens,
      }
    : { cacheWrite5mTokens: usage.cache_creation_input_tokens ?? 0, cacheWrite1hTokens: 0 };

export function attemptsFromUsage(
  usage: BetaUsage,
  requestedModel: string,
  servedModel: string,
): AiAttempt[] {
  const iterations = (usage.iterations ?? []).filter(
    (entry: Iteration): entry is Extract<Iteration, { type: 'message' | 'fallback_message' }> =>
      entry.type === 'message' || entry.type === 'fallback_message',
  );
  if (iterations.length === 0) {
    return [
      {
        kind: 'message',
        model: servedModel,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        ...cacheWrites(usage),
      },
    ];
  }
  return iterations.map((entry) => ({
    kind: entry.type,
    model: entry.model ?? requestedModel,
    inputTokens: entry.input_tokens,
    outputTokens: entry.output_tokens,
    cacheReadTokens: entry.cache_read_input_tokens,
    ...cacheWrites(entry),
  }));
}

/** A rough upper bound of the tokens of a text, for the quota estimate before a call. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3);
