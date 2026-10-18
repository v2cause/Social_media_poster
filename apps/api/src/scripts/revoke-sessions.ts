import { createPrismaClient } from '@smp/db';
import { createLogger } from '@smp/observability';

import { loadApiEnv } from '../config/api-env';
import { revokeSessions, revokeTargetOf } from '../modules/identity/revoke-sessions';

// `pnpm auth:revoke-sessions --user <email>` or `--all` in the API container
// (docs/runbooks/secret-rotation.md): ends sessions at once. Logs the count, never the address.

async function main(): Promise<void> {
  const env = loadApiEnv(process.env);
  const logger = createLogger({ service: 'api', environment: env.NODE_ENV, level: env.LOG_LEVEL });
  const target = revokeTargetOf(process.argv.slice(2));
  if (!target) {
    logger.error('auth.revoke_sessions_usage: --user <email> or --all');
    process.exitCode = 2;
    return;
  }
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const report = await revokeSessions(prisma, target);
    logger.info({ target: 'all' in target ? 'all' : 'user', ...report }, 'auth.sessions_revoked');
    if (!report.found) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
