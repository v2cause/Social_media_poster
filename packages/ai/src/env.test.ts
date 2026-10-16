import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AnthropicAiProvider } from './anthropic/anthropic-ai-provider';
import { createAiProvider } from './create-ai-provider';
import { aiEfforts, aiEnvSchema, checkAiEnv } from './env';
import { MockAiProvider } from './mock/mock-ai-provider';

// The AI settings as an app reads them: its env schema extends aiEnvSchema and refines it with
// checkAiEnv, so the mock never starts in production (guide step 2.5).
const appEnvSchema = aiEnvSchema
  .extend({ NODE_ENV: z.enum(['development', 'test', 'production']).default('development') })
  .superRefine(checkAiEnv);

const issuesOf = (source: Record<string, string>): string[] => {
  const result = appEnvSchema.safeParse(source);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('aiEnvSchema', () => {
  it('applies the defaults of .env.example, also for empty values', () => {
    for (const source of [
      {},
      { AI_PROVIDER: '', AI_MODEL: '', AI_REFUSAL_FALLBACK: '', AI_MONTHLY_CAP_MICROS: '' },
    ]) {
      const env = aiEnvSchema.parse(source);

      expect(env).toEqual({
        AI_PROVIDER: 'mock',
        ANTHROPIC_API_KEY: undefined,
        AI_MODEL: 'claude-opus-5-5',
        AI_EFFORT_GENERATE: 'medium',
        AI_EFFORT_REFINE: 'low',
        AI_EFFORT_IDEAS: 'medium',
        AI_EFFORT_ALT_TEXT: 'low',
        AI_REFUSAL_FALLBACK: true,
        AI_MONTHLY_CAP_MICROS: 10_000_000,
      });
      expect(aiEfforts(env)).toEqual({ generate: 'medium', refine: 'low', ideas: 'medium', altText: 'low' });
    }
  });

  it('parses the switches and numbers from their string form', () => {
    const env = aiEnvSchema.parse({
      AI_REFUSAL_FALLBACK: 'false',
      AI_MONTHLY_CAP_MICROS: '2500000',
      AI_EFFORT_GENERATE: 'high',
    });

    expect(env.AI_REFUSAL_FALLBACK).toBe(false);
    expect(env.AI_MONTHLY_CAP_MICROS).toBe(2_500_000);
    expect(env.AI_EFFORT_GENERATE).toBe('high');
  });

  it('rejects unknown providers, efforts and negative caps', () => {
    expect(issuesOf({ AI_PROVIDER: 'openai' })).toEqual([expect.stringMatching(/^AI_PROVIDER: /)]);
    expect(issuesOf({ AI_EFFORT_REFINE: 'none' })).toEqual([expect.stringMatching(/^AI_EFFORT_REFINE: /)]);
    expect(issuesOf({ AI_MONTHLY_CAP_MICROS: '-1' })).toEqual([
      expect.stringMatching(/^AI_MONTHLY_CAP_MICROS: /),
    ]);
  });

  it('refuses the mock in production', () => {
    expect(issuesOf({ NODE_ENV: 'production' })).toEqual([
      'AI_PROVIDER: the mock provider is not allowed in production',
    ]);
    expect(issuesOf({ NODE_ENV: 'production', AI_PROVIDER: 'mock' })).toHaveLength(1);
    expect(issuesOf({ NODE_ENV: 'test', AI_PROVIDER: 'mock' })).toEqual([]);
  });

  it('needs a key for the Claude API and does not echo it', () => {
    expect(issuesOf({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' })).toEqual([
      'ANTHROPIC_API_KEY: required when AI_PROVIDER is anthropic',
    ]);
    expect(
      issuesOf({ NODE_ENV: 'production', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key' }),
    ).toEqual([]);
  });
});

describe('createAiProvider', () => {
  it('creates the mock outside production', () => {
    const provider = createAiProvider(aiEnvSchema.parse({}), { nodeEnv: 'test' });

    expect(provider).toBeInstanceOf(MockAiProvider);
    expect(provider.name).toBe('mock');
  });

  it('refuses the mock in production, even without the env check', () => {
    expect(() => createAiProvider(aiEnvSchema.parse({}), { nodeEnv: 'production' })).toThrow(
      'AI_PROVIDER=mock is not allowed in production',
    );
  });

  it('creates the Claude API provider with a key and refuses it without one', () => {
    const env = aiEnvSchema.parse({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test-key' });

    expect(createAiProvider(env, { nodeEnv: 'production' })).toBeInstanceOf(AnthropicAiProvider);
    expect(() =>
      createAiProvider({ ...env, ANTHROPIC_API_KEY: undefined }, { nodeEnv: 'production' }),
    ).toThrow('ANTHROPIC_API_KEY is required when AI_PROVIDER is anthropic');
  });
});
