import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import {
  systemClock,
  uuidV7Ids,
  type AdapterResolver,
  type AnalyticsJobDependencies,
  type ConnectionLock,
} from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import { createPrismaClient, PrismaAnalyticsUnitOfWork, type PrismaClient } from '@smp/db';
import { createAdapterRegistry, operationPriceMicros, RedisMockPlatformStore } from '@smp/platform-adapters';
import { ANALYTICS_QUEUE, AnalyticsProducer, withLock } from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import type { WorkerEnv } from '../worker-env';
import { ANALYTICS_PIPELINE } from '../worker.tokens';
import { livePlatforms } from './live-platforms';
import { spendCappedResolver } from './spend-cap';
import { xBrowserWiring, type XBrowserWiring } from './x-browser.providers';

// The adapters of the role "analytics" (guide step 5.2): the database as app_user in the tenant
// of each job, the token keyring, the platform adapters of PLATFORM_MODE_* (the mock platforms
// keep their state in Redis, shared with the publisher), the lock of a connection, which a
// token refresh before a poll shares with the publish job, and the producer of the rollups.

/** How long the lock of a connection lasts, and how long a poll waits for it. */
const CONNECTION_LOCK_TTL_MS = 30_000;
const CONNECTION_LOCK_WAIT_MS = 15_000;

/** What the analytics jobs need, apart from their loggers. */
export interface AnalyticsPipeline {
  deps: Omit<AnalyticsJobDependencies, 'logger'>;
}

interface AnalyticsClients {
  database: PrismaClient;
  redis: Redis;
  rollupQueue: Queue;
  producers: Redis;
  xBrowser: XBrowserWiring;
}

const ANALYTICS_CLIENTS = Symbol('ANALYTICS_CLIENTS');

@Injectable()
class AnalyticsClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(ANALYTICS_CLIENTS) private readonly clients: AnalyticsClients) {}

  async onApplicationShutdown(): Promise<void> {
    await this.clients.xBrowser.close();
    await this.clients.rollupQueue.close();
    // A queue leaves a connection it was given open.
    this.clients.producers.disconnect();
    this.clients.redis.disconnect();
    await this.clients.database.$disconnect();
  }
}

export function analyticsPipeline(env: WorkerEnv): Provider[] {
  // The keyring is checked at the start, not with the first poll.
  const sealer = sealerFromEnv('tokens', env);
  // app_user with the tenant of each job: row-level security applies to the worker too.
  const database = createPrismaClient(env.DATABASE_URL);
  // Locks and the mock platforms; a command fails instead of waiting while Redis is away.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const xBrowser = xBrowserWiring(env, database);
  const registry = createAdapterRegistry({
    env,
    mock: { store: new RedisMockPlatformStore(redis), clock: systemClock },
    live: livePlatforms(env, redis),
    ...(xBrowser.browser ? { browser: xBrowser.browser } : {}),
  });
  // The X API stays within the spending cap of the plan (guide step 7.4).
  const adapters: AdapterResolver = spendCappedResolver(registry, database);
  // The producer fails fast instead of queueing commands while Redis is away; the nightly
  // rollup fills the days of a lost request.
  const producers = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false });
  const rollupQueue = new Queue(ANALYTICS_QUEUE, { connection: producers });
  const rollups = new AnalyticsProducer(rollupQueue);
  const locks: ConnectionLock = {
    withConnectionLock: (connectionId, work) =>
      withLock(redis, `lock:conn:${connectionId}`, CONNECTION_LOCK_TTL_MS, () => work(), {
        waitMs: CONNECTION_LOCK_WAIT_MS,
      }),
  };
  const pipeline: AnalyticsPipeline = {
    deps: {
      unitOfWork: new PrismaAnalyticsUnitOfWork(database),
      adapters,
      sealer,
      locks,
      prices: { priceMicros: operationPriceMicros },
      clock: systemClock,
      ids: uuidV7Ids,
      rollups: { request: (rollup) => rollups.rollup(rollup) },
      cadenceScale: env.ANALYTICS_CADENCE_SCALE,
    },
  };
  return [
    {
      provide: ANALYTICS_CLIENTS,
      useValue: { database, redis, rollupQueue, producers, xBrowser } satisfies AnalyticsClients,
    },
    AnalyticsClientsLifecycle,
    { provide: ANALYTICS_PIPELINE, useValue: pipeline },
  ];
}
