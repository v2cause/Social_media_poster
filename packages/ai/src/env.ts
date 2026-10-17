import { AI_EFFORTS, type AiEffort, type AiRoute } from '@smp/core';
import { z } from 'zod';

// The AI settings of the API and the worker (architecture 5.1, .env.example). Apps extend their
// env schema with aiEnvSchema and add checkAiEnv as a refinement, so a bad combination stops the
// start with a message that names the variable.

// .env.example and Compose set empty strings for unset values.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const AI_PROVIDERS = ['anthropic', 'mock'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

const effort = (fallback: AiEffort) => z.preprocess(unsetIfEmpty, z.enum(AI_EFFORTS).default(fallback));

export const aiEnvSchema = z.object({
  AI_PROVIDER: z.preprocess(unsetIfEmpty, z.enum(AI_PROVIDERS).default('mock')),
  ANTHROPIC_API_KEY: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  AI_MODEL: z.preprocess(unsetIfEmpty, z.string().min(1).default('claude-opus-5-5')),
  AI_EFFORT_GENERATE: effort('medium'),
  AI_EFFORT_REFINE: effort('low'),
  AI_EFFORT_IDEAS: effort('medium'),
  AI_EFFORT_ALT_TEXT: effort('low'),
  AI_REFUSAL_FALLBACK: z.preprocess(unsetIfEmpty, z.stringbool().default(true)),
});

export type AiEnv = z.infer<typeof aiEnvSchema>;

interface IssueSink {
  addIssue(issue: { code: 'custom'; path: string[]; message: string }): void;
}

/**
 * The rules across variables, for superRefine: the mock never runs in production (guide step 2.5)
 * and the Claude API needs a key.
 */
export function checkAiEnv(
  env: Pick<AiEnv, 'AI_PROVIDER' | 'ANTHROPIC_API_KEY'> & { NODE_ENV: string },
  ctx: IssueSink,
): void {
  if (env.AI_PROVIDER === 'mock' && env.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['AI_PROVIDER'],
      message: 'the mock provider is not allowed in production',
    });
  }
  if (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['ANTHROPIC_API_KEY'],
      message: 'required when AI_PROVIDER is anthropic',
    });
  }
}

/** The effort of every route; fixed per route so the prompt cache holds. */
export const aiEfforts = (env: AiEnv): Readonly<Record<AiRoute, AiEffort>> => ({
  generate: env.AI_EFFORT_GENERATE,
  refine: env.AI_EFFORT_REFINE,
  ideas: env.AI_EFFORT_IDEAS,
  altText: env.AI_EFFORT_ALT_TEXT,
});
