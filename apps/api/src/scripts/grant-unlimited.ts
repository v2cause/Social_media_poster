import { createLogger } from '@smp/observability';

import { loadApiEnv } from '../config/api-env';
import { openUnlimitedAccess } from '../infrastructure/unlimited-access';
import { grantUnlimited, unlimitedGrantRequestOf } from '../modules/billing/grant-unlimited';

// `pnpm billing:grant-unlimited --owner <email> [--ticket <reference>] [--check]` in the API
// container or on the machine of the app (ADR 0047): lets every organization the person owns run
// without limits and without costs, for the operators' own use. --check only lists them. Logs the
// user ID, the IDs of the organizations and the outcomes, never the address.

async function main(): Promise<void> {
  const env = loadApiEnv(process.env);
  const logger = createLogger({ service: 'api', environment: env.NODE_ENV, level: env.LOG_LEVEL });
  const request = unlimitedGrantRequestOf(process.argv.slice(2));
  if (!request) {
    logger.error('billing.unlimited_usage: --owner <email> [--ticket <reference>] [--check]');
    process.exitCode = 2;
    return;
  }
  const connection = openUnlimitedAccess(env.DATABASE_SYSTEM_URL);
  try {
    const outcome = await grantUnlimited(connection.access, request, new Date());
    switch (outcome.status) {
      case 'user_not_found':
        logger.warn({ ticket: request.ticket }, 'billing.unlimited_user_not_found');
        process.exitCode = 1;
        break;
      case 'no_organization':
        logger.warn({ ticket: request.ticket, userId: outcome.userId }, 'billing.unlimited_no_organization');
        process.exitCode = 1;
        break;
      case 'checked':
        logger.info(
          { ticket: request.ticket, userId: outcome.userId, organizations: outcome.organizations },
          'billing.unlimited_check',
        );
        break;
      case 'done':
        logger.warn(
          { ticket: request.ticket, userId: outcome.userId, results: outcome.results },
          'billing.unlimited_granted',
        );
        if (outcome.results.some((entry) => entry.result === 'billed_by_stripe')) {
          process.exitCode = 1;
        }
        break;
    }
  } finally {
    await connection.close();
  }
}

void main();
