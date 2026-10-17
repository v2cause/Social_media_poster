import { observabilityEnvSchema } from '@smp/observability';
import { egressHostsEnvSchema } from '@smp/x-browser';
import { z } from 'zod';

// The browser worker holds no database credentials and no S3 credentials (guide step 6.2). It
// talks to Redis, to the web app of X and to the media storage through signed URLs, and it is
// the only process that opens the sessions of X, with the keyring SESSION_KEKS.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const browserWorkerEnvSchema = z
  .object({
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Global kill switch for the optional X browser adapter.
    FEATURE_X_BROWSER_GLOBAL: z.stringbool().default(false),
    // Checked by the keyring on start; required once the X browser is offered.
    SESSION_KEKS: z.preprocess(unsetIfEmpty, z.string().optional()),
    SESSION_KEK_ACTIVE: z.preprocess(unsetIfEmpty, z.string().optional()),
    // The origins of the media storage on top of the hosts of X, comma-separated, for example
    // the origin of S3_PUBLIC_ENDPOINT.
    XB_EGRESS_HOSTS: z.preprocess(unsetIfEmpty, egressHostsEnvSchema),
    // The egress proxy of the network, for example http://egress-proxy:3128; unset in development.
    XB_EGRESS_PROXY: z.preprocess(unsetIfEmpty, z.url({ protocol: /^https?$/ }).optional()),
    // Commands at the same time, each in its own browser context (architecture 4.3).
    XB_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
    // A preinstalled Chromium outside the image of Playwright, for example in development.
    PLAYWRIGHT_CHROMIUM_EXECUTABLE: z.preprocess(unsetIfEmpty, z.string().optional()),
  })
  .extend(observabilityEnvSchema.pick({ NODE_ENV: true, LOG_LEVEL: true }).shape)
  .superRefine((env, context) => {
    if (env.FEATURE_X_BROWSER_GLOBAL && (!env.SESSION_KEKS || !env.SESSION_KEK_ACTIVE)) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_KEKS'],
        message: 'SESSION_KEKS and SESSION_KEK_ACTIVE are required when FEATURE_X_BROWSER_GLOBAL is true',
      });
    }
  });

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
