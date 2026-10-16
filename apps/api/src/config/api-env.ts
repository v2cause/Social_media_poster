import { dbEnvSchema } from '@smp/db';
import { observabilityEnvSchema } from '@smp/observability';
import { z } from 'zod';

// The API connects only as app_user and app_system. MIGRATION_DATABASE_URL belongs to the migrations.
export const apiEnvSchema = z
  .object({
    APP_URL: z.url(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: z.stringbool().default(true),
    // Better Auth: signs session cookies and tokens. Generate with `pnpm gen:keys`.
    BETTER_AUTH_SECRET: z.string().min(32),
    // The public origin the browser talks to (same origin as the web app).
    BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
  })
  .extend(dbEnvSchema.pick({ DATABASE_URL: true, DATABASE_SYSTEM_URL: true }).shape)
  .extend(observabilityEnvSchema.shape);

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
