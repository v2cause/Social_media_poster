import { observabilityEnvSchema } from '@smp/observability';
import { z } from 'zod';

// The browser worker holds no database credentials and no S3 credentials. It only talks to Redis.
export const browserWorkerEnvSchema = z
  .object({
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Global kill switch for the optional X browser adapter.
    FEATURE_X_BROWSER_GLOBAL: z.stringbool().default(false),
  })
  .extend(observabilityEnvSchema.pick({ NODE_ENV: true, LOG_LEVEL: true }).shape);

export type BrowserWorkerEnv = z.infer<typeof browserWorkerEnvSchema>;

/** Validates the process environment. Failures name the variables, never their values. */
export function loadBrowserWorkerEnv(source: NodeJS.ProcessEnv): BrowserWorkerEnv {
  const result = browserWorkerEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
