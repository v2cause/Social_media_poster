import { LocalModeSubscriptionReader, type SubscriptionReader } from '@smp/core';
import { PrismaSubscriptionReader, type PrismaClient } from '@smp/db';

import type { WorkerEnv } from '../worker-env';

/**
 * The subscriptions the worker checks plans against. The single-user mode has no billing, so
 * every organization reads as active and without limits there (ADR 0046).
 */
export function subscriptionReaderOf(
  database: PrismaClient,
  env: Pick<WorkerEnv, 'LOCAL_MODE'>,
): SubscriptionReader {
  const subscriptions = new PrismaSubscriptionReader(database);
  return env.LOCAL_MODE ? new LocalModeSubscriptionReader(subscriptions) : subscriptions;
}
