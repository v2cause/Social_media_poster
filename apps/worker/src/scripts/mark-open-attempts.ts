import { dbEnvSchema } from '@smp/db';
import { createLogger, observabilityEnvSchema } from '@smp/observability';

import { markOpenAttempts } from '../infrastructure/restore-attempts';
import { restoreSinceOf } from '../publisher/restore-marks';

// `node dist/scripts/mark-open-attempts.js --since <time>` in the worker image after a restore to
// an earlier time, before the role "publisher" runs again (docs/runbooks/backup-restore.md, ADR
// 0042; locally after `pnpm build`: pnpm restore:mark-attempts --since <time>). Every variant the
// publisher still has to send gets an open attempt at that time, so its next run looks on the
// platform for its post since then before it sends. Logs the counts.

const envSchema = dbEnvSchema
  .pick({ DATABASE_SYSTEM_URL: true })
  .extend(observabilityEnvSchema.pick({ NODE_ENV: true, LOG_LEVEL: true }).shape);

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const logger = createLogger({ service: 'worker', environment: env.NODE_ENV, level: env.LOG_LEVEL });
  const since = restoreSinceOf(process.argv.slice(2), new Date());
  if (!since) {
    logger.error('restore.mark_attempts_usage: --since <time in ISO 8601 with offset, not in the future>');
    process.exitCode = 2;
    return;
  }
  const marks = await markOpenAttempts(env.DATABASE_SYSTEM_URL, since);
  logger.info({ since: since.toISOString(), ...marks }, 'restore.attempts_marked');
}

void main();
