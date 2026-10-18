import { createHash } from 'node:crypto';

import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import {
  CompleteBrowserLogin,
  RecordBrowserLoginStep,
  StoreBrowserSession,
  type XBrowserBreaker,
  systemClock,
  uuidV7Ids,
  type AccountLimits,
  type AdapterResolver,
  type ConnectionLock,
  type PublishJobDependencies,
  type RefreshConnectionDependencies,
} from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import {
  createPrismaClient,
  PrismaChannelUnitOfWork,
  PrismaPublishJobUnitOfWork,
  PrismaTokenMaintenanceUnitOfWork,
  PrismaXBrowserUnitOfWork,
  type PrismaClient,
} from '@smp/db';
import { S3Storage, storageConfigOf } from '@smp/media';
import {
  createAdapterRegistry,
  operationPriceMicros,
  RedisBrowserLoginStore,
  RedisMockPlatformStore,
} from '@smp/platform-adapters';
import {
  LiveBrowserLoginEvents,
  LiveEventPublisher,
  PUBLISH_DEAD_LETTER_QUEUE,
  PublishDeadLetters,
  withLock,
} from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import type { WorkerEnv } from '../worker-env';
import { PUBLISH_PIPELINE } from '../worker.tokens';
import { spendCappedResolver } from './spend-cap';
import {
  xBrowserBreakerOf,
  xBrowserWiring,
  type BreakerWiring,
  type XBrowserWiring,
} from './x-browser.providers';

// The adapters of the role "publisher" (guide steps 4.8 and 4.9): the database as app_user in
// the tenant of each job, the token keyring, the platform adapters of PLATFORM_MODE_* (the mock
// platforms keep their state in Redis, shared with the API), the lock of a connection for its
// token refresh (before a post and in token.refresh), the storage that signs the URLs of the
// renditions, and the dead-letter queue.

/** How long the lock of a connection lasts, and how long a run waits for it. */
const CONNECTION_LOCK_TTL_MS = 30_000;
const CONNECTION_LOCK_WAIT_MS = 15_000;

/** Without the X browser no login reports; one that does anyway connects nothing. */
const NO_BROWSER_ACCOUNTS: AccountLimits = {
  assertRoom: () => Promise.reject(new Error('The X browser is off in this worker.')),
};

/** What the publish worker and the token refresh need, apart from their loggers. */
export interface PublishPipeline {
  deps: Omit<PublishJobDependencies, 'logger'>;
  /** token.refresh shares the adapters, the keyring and the lock of a connection. */
  tokenRefresh: Omit<RefreshConnectionDependencies, 'logger'>;
  /** The connection of the BullMQ worker; blocking commands wait on it. */
  workerConnection: Redis;
  /** Copies of the jobs that failed for good (architecture 7.1). */
  deadLetters: PublishDeadLetters;
  /** The sessions the browser worker reports on xb-results (guide step 6.2). */
  browserSessions: StoreBrowserSession;
  /** The steps of the logins of X it reports there, up to the connected account (guide step 6.4). */
  browserLogins: { steps: RecordBrowserLoginStep; completion: CompleteBrowserLogin };
  /** The circuit breaker of its drifts and canaries (guide step 6.5); null without the X browser. */
  breaker: XBrowserBreaker | null;
}

/** The connections of the publisher, closed when the worker shuts down. */
interface PublisherClients {
  database: PrismaClient;
  storage: S3Storage;
  redis: Redis;
  workerConnection: Redis;
  deadLetterQueue: Queue;
  deadLetterConnection: Redis;
  xBrowser: XBrowserWiring;
  breaker: BreakerWiring | null;
}

const PUBLISHER_CLIENTS = Symbol('PUBLISHER_CLIENTS');

@Injectable()
class PublisherClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PUBLISHER_CLIENTS) private readonly clients: PublisherClients) {}

  // The publish worker stops earlier, in onModuleDestroy, so no run uses these any more.
  async onApplicationShutdown(): Promise<void> {
    this.clients.storage.destroy();
    await this.clients.xBrowser.close();
    await this.clients.breaker?.close();
    await this.clients.deadLetterQueue.close();
    this.clients.deadLetterConnection.disconnect();
    this.clients.workerConnection.disconnect();
    this.clients.redis.disconnect();
    await this.clients.database.$disconnect();
  }
}

export function publisherPipeline(env: WorkerEnv): Provider[] {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw new Error(
      'Invalid configuration:\n  S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for the role "publisher"',
    );
  }
  // The keyring is checked at the start, not with the first post.
  const sealer = sealerFromEnv('tokens', env);
  const storage = new S3Storage(
    storageConfigOf({
      S3_ENDPOINT,
      S3_PUBLIC_ENDPOINT: env.S3_PUBLIC_ENDPOINT,
      S3_REGION,
      S3_BUCKET,
      S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY,
      S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE ?? true,
    }),
  );
  // app_user with the tenant of each job: row-level security applies to the worker too.
  const database = createPrismaClient(env.DATABASE_URL);
  // Locks and the mock platforms; a command fails instead of waiting while Redis is away.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const workerConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // Producers fail fast instead of queueing commands while Redis is away.
  const deadLetterConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  const deadLetterQueue = new Queue(PUBLISH_DEAD_LETTER_QUEUE, { connection: deadLetterConnection });
  const xBrowser = xBrowserWiring(env, database);
  const breaker = xBrowserBreakerOf(env, redis, database);
  // Fails at the start when a platform is live without its adapter.
  const registry = createAdapterRegistry({
    env,
    mock: { store: new RedisMockPlatformStore(redis), clock: systemClock },
    ...(xBrowser.browser ? { browser: xBrowser.browser } : {}),
  });
  // The X API stays within the spending cap of the plan (guide step 7.4).
  const adapters: AdapterResolver = spendCappedResolver(registry, database);

  const locks: ConnectionLock = {
    withConnectionLock: (connectionId, work) =>
      withLock(redis, `lock:conn:${connectionId}`, CONNECTION_LOCK_TTL_MS, () => work(), {
        waitMs: CONNECTION_LOCK_WAIT_MS,
      }),
  };

  const browserLogins = {
    logins: new RedisBrowserLoginStore(redis),
    events: new LiveBrowserLoginEvents(new LiveEventPublisher(redis)),
    unitOfWork: new PrismaChannelUnitOfWork(database),
    // A new account of a login needs room in the plan when it connects (guide step 8.4).
    accounts: breaker?.accounts ?? NO_BROWSER_ACCOUNTS,
    clock: systemClock,
    ids: uuidV7Ids,
  };
  const pipeline: PublishPipeline = {
    deps: {
      unitOfWork: new PrismaPublishJobUnitOfWork(database),
      adapters,
      sealer,
      locks,
      storage,
      prices: { priceMicros: operationPriceMicros },
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      clock: systemClock,
      ids: uuidV7Ids,
      dryRunLive: env.PUBLISH_DRY_RUN,
      leaseMs: env.PUBLISH_LEASE_MS,
      metricsCadenceScale: env.ANALYTICS_CADENCE_SCALE,
    },
    tokenRefresh: {
      unitOfWork: new PrismaTokenMaintenanceUnitOfWork(database),
      adapters,
      sealer,
      locks,
      clock: systemClock,
    },
    workerConnection,
    deadLetters: new PublishDeadLetters(deadLetterQueue),
    browserSessions: new StoreBrowserSession({ unitOfWork: new PrismaXBrowserUnitOfWork(database) }),
    browserLogins: {
      steps: new RecordBrowserLoginStep(browserLogins),
      completion: new CompleteBrowserLogin(browserLogins),
    },
    breaker: breaker?.breaker ?? null,
  };
  return [
    {
      provide: PUBLISHER_CLIENTS,
      useValue: {
        database,
        storage,
        redis,
        workerConnection,
        deadLetterQueue,
        deadLetterConnection,
        xBrowser,
        breaker,
      } satisfies PublisherClients,
    },
    PublisherClientsLifecycle,
    { provide: PUBLISH_PIPELINE, useValue: pipeline },
  ];
}
