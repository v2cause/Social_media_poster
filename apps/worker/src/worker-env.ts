import { billingEnvSchema, checkBillingEnv } from '@smp/billing';
import { dbEnvSchema } from '@smp/db';
import { storageEnvSchema } from '@smp/media';
import { observabilityEnvSchema } from '@smp/observability';
import { platformEnvSchema } from '@smp/platform-adapters';
import { z } from 'zod';

const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const workerEnvSchema = z
  .object({
    WORKER_ROLES: z.string().min(1),
    // The interval of tick.publish (architecture 7.4); 2000 for time-lapse tests (architecture 16).
    SCHEDULER_TICK_MS: z.coerce.number().int().min(1_000).default(15_000),
    // 0 takes any free port, as the integration tests do.
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3002),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Needed by the role "notify" only; WorkerModule checks them when that role is active. The
    // links of the notification emails lead into the web app at APP_URL.
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    MAIL_FROM: z.string().min(3).optional(),
    APP_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Needed by the roles "scheduler" (re-wrap in tick.maintenance) and "gdpr" (the revocation of
    // the grants of an erased organization); @smp/crypto checks the format.
    TOKEN_KEKS: z.string().optional(),
    TOKEN_KEK_ACTIVE: z.string().optional(),
    SESSION_KEKS: z.string().optional(),
    SESSION_KEK_ACTIVE: z.string().optional(),
    // The role "publisher" (guide step 4.8): publish jobs at once per process; the BullMQ lock of
    // a running job, renewed while it runs, after which a stopped worker's job is taken over; and
    // the lease of a run in the database (5 minutes, architecture 7).
    PUBLISH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    PUBLISH_LOCK_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    PUBLISH_LEASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
    // Speeds the polling cascade of the post metrics up for time-lapse tests: 60 turns an hour
    // into a minute (architecture 16). Read by the roles "publisher" and "analytics".
    ANALYTICS_CADENCE_SCALE: z.coerce.number().int().min(1).max(3_600).default(1),
    // The deployment runs the browser worker: the roles "publisher" and "analytics" then reach X
    // without the API through xb-commands, where the gate of the workspace allows it (phase 6).
    FEATURE_X_BROWSER_GLOBAL: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
    // The internal test account of X whose browser session the role "scheduler" runs the daily
    // canary with (guide step 6.5); unset, no canary runs.
    XB_CANARY_ACCOUNT_ID: z.preprocess(unsetIfEmpty, z.uuid().optional()),
  })
  .extend(dbEnvSchema.pick({ DATABASE_URL: true }).shape)
  // Needed by the roles "scheduler" (scans across workspaces) and "billing" (app_system).
  .extend(dbEnvSchema.pick({ DATABASE_SYSTEM_URL: true }).partial().shape)
  // Needed by the role "billing" (guide step 7.2), which reads the subscriptions from Stripe; it
  // never checks the signature of a webhook, the API did.
  .extend(billingEnvSchema.pick({ STRIPE_SECRET_KEY: true, STRIPE_API_BASE: true }).shape)
  // Needed by the roles "media" and "publisher"; WorkerModule checks them when one is active.
  .extend(storageEnvSchema.partial().shape)
  // Mock or live per platform and PUBLISH_DRY_RUN, for the roles "publisher" and "analytics".
  .extend(platformEnvSchema.shape)
  .extend(observabilityEnvSchema.shape)
  .superRefine(checkBillingEnv);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Validates the process environment. Failures name the variables, never their values. */
export function loadWorkerEnv(source: NodeJS.ProcessEnv): WorkerEnv {
  const result = workerEnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
