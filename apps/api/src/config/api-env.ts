import { aiEnvSchema, checkAiEnv } from '@smp/ai';
import { dbEnvSchema } from '@smp/db';
import { storageEnvSchema } from '@smp/media';
import { observabilityEnvSchema } from '@smp/observability';
import { platformEnvSchema } from '@smp/platform-adapters';
import { z } from 'zod';

// .env.example and Compose set empty strings for unset values.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

// The API connects only as app_user and app_system. MIGRATION_DATABASE_URL belongs to the migrations.
export const apiEnvSchema = z
  .object({
    APP_URL: z.url(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // The storage quota of a workspace until plans set it per organization (phase 7).
    MEDIA_STORAGE_LIMIT_BYTES: z.preprocess(
      unsetIfEmpty,
      z.coerce
        .number()
        .int()
        .min(1)
        .default(5 * 1024 ** 3),
    ),
    // The days of analytics every organization keeps until plans set it per organization
    // (phase 7); periods that start earlier are refused.
    ANALYTICS_HISTORY_DAYS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(7).max(3_650).default(365),
    ),
    // Better Auth: signs session cookies and tokens. Generate with `pnpm gen:keys`.
    BETTER_AUTH_SECRET: z.string().min(32),
    // The public origin the browser talks to (same origin as the web app).
    BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
    // Seal the tokens of the platforms; @smp/crypto checks the format at start.
    TOKEN_KEKS: z.string().min(1),
    TOKEN_KEK_ACTIVE: z.string().min(1),
  })
  .extend(dbEnvSchema.pick({ DATABASE_URL: true, DATABASE_SYSTEM_URL: true }).shape)
  .extend(storageEnvSchema.shape)
  .extend(observabilityEnvSchema.shape)
  .extend(aiEnvSchema.shape)
  .extend(platformEnvSchema.shape)
  // The mock AI provider never starts in production, and the Claude API needs a key.
  .superRefine(checkAiEnv);

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Validates the process environment. Failures name the variables and the rule that failed,
 * but never the rejected values.
 */
export function loadApiEnv(source: NodeJS.ProcessEnv): ApiEnv {
  const result = apiEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
