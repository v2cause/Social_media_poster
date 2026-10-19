import { sealerFromEnv } from '@smp/crypto';
import { createPrismaClient } from '@smp/db';
import { createLogger } from '@smp/observability';
import { NOTIFICATIONS_QUEUE, NotificationProducer } from '@smp/queue';
import { Queue } from 'bullmq';

import { loadApiEnv } from '../config/api-env';
import { openMembershipLookup } from '../infrastructure/user-memberships';
import {
  checkTwoFactorReset,
  resetTwoFactor,
  twoFactorResetRequestOf,
} from '../modules/identity/reset-two-factor';

// `pnpm auth:reset-two-factor --user <email> --ticket <reference> [--check]` in the API container
// (docs/runbooks/zweiter-faktor-verloren.md): --check reports the memberships and whether a
// password reset proves the address; without it, the command removes a lost second factor once
// the person reset the password through the link to the address. Logs the user ID, the IDs of the
// organizations and the ticket, never the address.

async function main(): Promise<void> {
  const env = loadApiEnv(process.env);
  const logger = createLogger({ service: 'api', environment: env.NODE_ENV, level: env.LOG_LEVEL });
  const request = twoFactorResetRequestOf(process.argv.slice(2));
  if (!request) {
    logger.error('auth.two_factor_reset_usage: --user <email> --ticket <reference> [--check]');
    process.exitCode = 2;
    return;
  }
  const prisma = createPrismaClient(env.DATABASE_URL);
  const lookup = openMembershipLookup(env.DATABASE_SYSTEM_URL);
  const queue = new Queue(NOTIFICATIONS_QUEUE, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
  });
  try {
    const now = new Date();
    if (request.check) {
      const found = await checkTwoFactorReset(
        { prisma, memberships: lookup.memberships },
        request.email,
        now,
      );
      if (found.status !== 'found') {
        logger.warn({ ticket: request.ticket, outcome: found.status }, 'auth.two_factor_check');
        process.exitCode = 1;
        return;
      }
      logger.info(
        {
          ticket: request.ticket,
          userId: found.userId,
          twoFactorEnabled: found.twoFactorEnabled,
          platformAdmin: found.platformAdmin,
          resetAt: found.resetAt?.toISOString() ?? null,
          memberships: found.memberships,
        },
        'auth.two_factor_check',
      );
      return;
    }
    const notifications = new NotificationProducer(queue, sealerFromEnv('tokens', env));
    const result = await resetTwoFactor(
      { prisma, memberships: lookup.memberships, notifications, appUrl: env.APP_URL },
      request.email,
      now,
    );
    if (result.status !== 'reset') {
      logger.warn({ ticket: request.ticket, outcome: result.status }, 'auth.two_factor_reset_refused');
      process.exitCode = 1;
      return;
    }
    logger.warn(
      {
        ticket: request.ticket,
        userId: result.userId,
        resetAt: result.resetAt.toISOString(),
        hadSecondFactor: result.hadSecondFactor,
        sessions: result.sessions,
        memberships: result.memberships,
      },
      'auth.two_factor_reset',
    );
  } finally {
    await Promise.all([prisma.$disconnect(), lookup.close(), queue.close()]);
  }
}

void main();
