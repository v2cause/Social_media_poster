import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';

import { attemptsFromUsage } from './pricing';

const usage = (overrides: Partial<BetaUsage>): BetaUsage =>
  ({
    cache_creation: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    iterations: null,
    ...overrides,
  }) as BetaUsage;

describe('attemptsFromUsage', () => {
  it('reads one attempt from the top-level usage when there are no iterations', () => {
    expect(
      attemptsFromUsage(
        usage({
          input_tokens: 120,
          output_tokens: 800,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
        }),
        'claude-opus-5-5',
        'claude-opus-5-5',
      ),
    ).toEqual([
      {
        kind: 'message',
        model: 'claude-opus-5-5',
        inputTokens: 120,
        outputTokens: 800,
        cacheReadTokens: 2000,
        cacheWrite5mTokens: 200,
        cacheWrite1hTokens: 100,
      },
    ]);
  });

  it('reads every attempt of a fallback from usage.iterations', () => {
    const attempts = attemptsFromUsage(
      usage({
        input_tokens: 400,
        output_tokens: 600,
        iterations: [
          {
            type: 'message',
            model: null,
            input_tokens: 500,
            output_tokens: 40,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: 'fallback_message',
            model: 'claude-opus-4-8',
            input_tokens: 400,
            output_tokens: 600,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1500,
            cache_creation: null,
          },
        ],
      }),
      'claude-opus-5-5',
      'claude-opus-4-8',
    );
    expect(attempts).toEqual([
      {
        kind: 'message',
        model: 'claude-opus-5-5',
        inputTokens: 500,
        outputTokens: 40,
        cacheReadTokens: 1000,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      {
        kind: 'fallback_message',
        model: 'claude-opus-4-8',
        inputTokens: 400,
        outputTokens: 600,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 1500,
        cacheWrite1hTokens: 0,
      },
    ]);
  });
});
