import { createPrismaClient } from '@smp/db';
import { createLogger } from '@smp/observability';

import { loadApiEnv } from '../config/api-env';
import { authSecretConfig } from '../modules/identity/auth-secrets';
import { reencryptTwoFactor } from '../modules/identity/reencrypt-two-factor';

// `pnpm auth:reencrypt` in the API container, after BETTER_AUTH_SECRETS got a new current key
// (docs/runbooks/secret-rotation.md). Logs the counts, never a secret; fails if a row could not
// be opened or changed meanwhile, so that the run is repeated before an old key goes.

async function main(): Promise<void> {
  const env = loadApiEnv(process.env);
  const logger = createLogger({ service: 'api', environment: env.NODE_ENV, level: env.LOG_LEVEL });
  const key = authSecretConfig(env);
  if (!key) {
    logger.error('auth.reencrypt_without_versions');
    process.exitCode = 1;
    return;
  }
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const report = await reencryptTwoFactor(prisma, key);
    logger.info({ ...report, currentVersion: key.currentVersion }, 'auth.reencrypt_done');
    if (report.failed > 0 || report.changedMeanwhile > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
