import { dbEnvSchema } from '@smp/db';
import { storageEnvSchema } from '@smp/media';
import { observabilityEnvSchema } from '@smp/observability';
import { z } from 'zod';

export const workerEnvSchema = z
  .object({
    WORKER_ROLES: z.string().min(1),
    // The interval of tick.publish (architecture 7.4); 2000 for time-lapse tests (architecture 16).
    SCHEDULER_TICK_MS: z.coerce.number().int().min(1_000).default(15_000),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Needed by the role "notify" only; WorkerModule checks it when that role is active.
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    MAIL_FROM: z.string().min(3).optional(),
    // Needed by the role "scheduler" (re-wrap in tick.maintenance); @smp/crypto checks the format.
    TOKEN_KEKS: z.string().optional(),
    TOKEN_KEK_ACTIVE: z.string().optional(),
    SESSION_KEKS: z.string().optional(),
    SESSION_KEK_ACTIVE: z.string().optional(),
  })
  .extend(dbEnvSchema.pick({ DATABASE_URL: true }).shape)
  // Needed by the role "scheduler" for its scans across workspaces (app_system).
  .extend(dbEnvSchema.pick({ DATABASE_SYSTEM_URL: true }).partial().shape)
  // Needed by the role "media" only; WorkerModule checks them when that role is active.
  .extend(storageEnvSchema.partial().shape)
  .extend(observabilityEnvSchema.shape);

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
