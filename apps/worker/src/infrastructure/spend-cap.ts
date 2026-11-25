import {
  EntitlementsService,
  planXSpendCap,
  systemClock,
  type AdapterResolver,
  type SocialPlatformAdapter,
} from '@smp/core';
import { PrismaApiCostReader, type PrismaClient } from '@smp/db';
import { AdapterNotAvailableError, isSpendCapped, spendCappedAdapter } from '@smp/platform-adapters';

import type { WorkerEnv } from '../worker-env';
import { subscriptionReaderOf } from './subscriptions';

// The adapters of the roles "publisher" and "analytics" with the spending cap of the plan on the
// X API (guide step 7.4): a post or a poll that would pass the cap of the month fails with
// SPEND_CAP_REACHED before it is sent. The plan comes from the subscription, the costs of the
// month from the cost ledger, both as app_user in the tenant of the organization.

/** A plan change reaches the workers within a minute. */
const ENTITLEMENTS_CACHE_MS = 60_000;

/** Resolves the adapters of the registry; an adapter that is not available resolves to null. */
export function spendCappedResolver(
  registry: { resolve(account: Parameters<AdapterResolver['resolve']>[0]): Promise<SocialPlatformAdapter> },
  database: PrismaClient,
  env: Pick<WorkerEnv, 'LOCAL_MODE'>,
): AdapterResolver {
  const cap = planXSpendCap(
    new EntitlementsService({
      subscriptions: subscriptionReaderOf(database, env),
      clock: systemClock,
      cacheMs: ENTITLEMENTS_CACHE_MS,
    }),
    new PrismaApiCostReader(database),
    systemClock,
  );
  return {
    resolve: async (account) => {
      try {
        const adapter = await registry.resolve(account);
        return isSpendCapped(adapter) ? spendCappedAdapter(adapter, account.organizationId, cap) : adapter;
      } catch (error) {
        if (error instanceof AdapterNotAvailableError) {
          return null;
        }
        throw error;
      }
    },
  };
}
