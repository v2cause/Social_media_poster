import { dbEnvSchema } from '@smp/db';
import { observabilityEnvSchema } from '@smp/observability';
import { z } from 'zod';

export const workerEnvSchema = z
  .object({
    WORKER_ROLES: z.string().min(1),
    SCHEDULER_TICK_MS: z.coerce.number().int().min(1_000).default(60_000),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Needed by the role "notify" only; WorkerModule checks it when that role is active.
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    MAIL_FROM: z.string().min(3).optional(),
  })
  .extend(dbEnvSchema.pick({ DATABASE_URL: true }).shape)
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
