import type { AiProvider } from '@smp/core';

import { AnthropicAiProvider, type AiLogger } from './anthropic/anthropic-ai-provider';
import { ClaudeCodeAiProvider } from './claude-code/claude-code-ai-provider';
import { SpawnClaudeCliRunner } from './claude-code/claude-cli';
import type { AiEnv } from './env';
import { MockAiProvider } from './mock/mock-ai-provider';

export interface AiRuntime {
  nodeEnv: 'development' | 'test' | 'production';
  logger?: AiLogger;
}

/**
 * The provider AI_PROVIDER selects. Refuses the mock in production, as a second line behind the
 * env check (checkAiEnv), so the API and the worker do not start with it (guide step 2.5).
 */
export function createAiProvider(env: AiEnv, runtime: AiRuntime): AiProvider {
  if (env.AI_PROVIDER === 'mock') {
    if (runtime.nodeEnv === 'production') {
      throw new Error('AI_PROVIDER=mock is not allowed in production');
    }
    return new MockAiProvider({ model: env.AI_MODEL });
  }
  if (env.AI_PROVIDER === 'claude-code') {
    return new ClaudeCodeAiProvider({
      runner: new SpawnClaudeCliRunner(env.CLAUDE_CODE_PATH),
      model: env.AI_MODEL,
      timeoutMs: env.CLAUDE_CODE_TIMEOUT_MS,
    });
  }
  if (env.ANTHROPIC_API_KEY === undefined) {
    throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER is anthropic');
  }
  return new AnthropicAiProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.AI_MODEL,
    refusalFallback: env.AI_REFUSAL_FALLBACK,
    ...(runtime.logger ? { logger: runtime.logger } : {}),
  });
}
