import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { createStripeClient, StripeBillingGateway } from '@smp/billing';
import {
  CleanUpMedia,
  EraseOrganization,
  ExpireExports,
  ExportOrganizationData,
  revokeAtPlatform,
  ScheduleErasures,
  systemClock,
  type GdprRequestRunner,
  type GrantRevoker,
} from '@smp/core';
import { notifySealerFromEnv, sealerFromEnv } from '@smp/crypto';
import {
  createSystemPrismaClient,
  PrismaBillingDirectory,
  PrismaGdprRequestRunner,
  PrismaMediaCleanupStore,
  PrismaOrganizationDataSource,
  PrismaOrganizationEraser,
  type SystemPrismaClient,
} from '@smp/db';
import { S3Storage, storageConfigOf } from '@smp/media';
import { createAdapterRegistry, RedisMockPlatformStore } from '@smp/platform-adapters';
import { GDPR_QUEUE, GdprProducer, NOTIFICATIONS_QUEUE, NotificationProducer } from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import type { WorkerEnv } from '../worker-env';
import { GDPR_PIPELINE } from '../worker.tokens';
import { EmailGdprNotifier } from './gdpr-notifier';
import { ZipExportArchives } from './zip-export-archives';

// The adapters of the role "gdpr" (guide steps 8.1 to 8.3, ADR 0036 to 0038): the database as
// app_system, because an export reads every workspace of an organization, an erasure outlives it
// and the clean-up of the media library spans all workspaces; the object storage, which takes the
// archive while it is written and holds the media library; the queue of the role "notify" for the
// email to the owner, whose link leads into the web app at APP_URL; the adapters of the platforms
// with the key ring of the tokens, to revoke the grants of an erased organization; Stripe, when it
// is set up, to delete its customer; and the queue "gdpr" itself, to which the sweep hands the due
// erasures.

/** What the processor of the queue "gdpr" runs. */
export interface GdprPipeline {
  exporter: ExportOrganizationData;
  expire: ExpireExports;
  eraser: EraseOrganization;
  schedule: ScheduleErasures;
  media: CleanUpMedia;
  requests: GdprRequestRunner;
}

/** The connections of the role, closed when the worker shuts down. */
interface GdprClients {
  system: SystemPrismaClient;
  storage: S3Storage;
  notifications: Queue;
  gdpr: Queue;
  redis: Redis;
}

const GDPR_CLIENTS = Symbol('GDPR_CLIENTS');

@Injectable()
class GdprClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(GDPR_CLIENTS) private readonly clients: GdprClients) {}

  async onApplicationShutdown(): Promise<void> {
    await this.clients.notifications.close();
    await this.clients.gdpr.close();
    this.clients.redis.disconnect();
    this.clients.storage.destroy();
    await this.clients.system.$disconnect();
  }
}

export function gdprPipeline(env: WorkerEnv): Provider[] {
  const {
    DATABASE_SYSTEM_URL,
    APP_URL,
    S3_ENDPOINT,
    S3_REGION,
    S3_BUCKET,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
  } = env;
  if (
    !DATABASE_SYSTEM_URL ||
    !APP_URL ||
    !S3_ENDPOINT ||
    !S3_REGION ||
    !S3_BUCKET ||
    !S3_ACCESS_KEY_ID ||
    !S3_SECRET_ACCESS_KEY
  ) {
    throw new Error(
      'Invalid configuration:\n  DATABASE_SYSTEM_URL, APP_URL, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for the role "gdpr"',
    );
  }
  const system = createSystemPrismaClient(DATABASE_SYSTEM_URL);
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
  // The producers fail fast instead of queueing commands while Redis is away.
  const producerConnection = { url: env.REDIS_URL, maxRetriesPerRequest: null, enableOfflineQueue: false };
  const notifications = new Queue(NOTIFICATIONS_QUEUE, { connection: producerConnection });
  const gdpr = new Queue(GDPR_QUEUE, { connection: producerConnection });
  const producer = new GdprProducer(gdpr);
  // The mock platforms keep their grants in Redis; a command fails instead of waiting.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  // Fails at the start when a platform is live without its adapter, like the role "publisher".
  const connectors = createAdapterRegistry({
    env,
    mock: { store: new RedisMockPlatformStore(redis), clock: systemClock },
  });
  const sealer = sealerFromEnv('tokens', env);
  const revoke: GrantRevoker = (connection) => {
    if (!connection.accessTokenSealed) {
      return Promise.resolve();
    }
    return revokeAtPlatform({ connectors, sealer }, connection, connection.accessTokenSealed);
  };
  // Without Stripe the customer stays there, and the record of the erasure says so.
  const billing = env.STRIPE_SECRET_KEY
    ? new StripeBillingGateway(
        createStripeClient({
          secretKey: env.STRIPE_SECRET_KEY,
          ...(env.STRIPE_API_BASE ? { apiBase: env.STRIPE_API_BASE } : {}),
        }),
      )
    : null;
  const requests = new PrismaGdprRequestRunner(system);
  const pipeline: GdprPipeline = {
    exporter: new ExportOrganizationData({
      requests,
      source: new PrismaOrganizationDataSource(system),
      archives: new ZipExportArchives(storage, () => systemClock.now()),
      storage,
      notifier: new EmailGdprNotifier({
        directory: new PrismaBillingDirectory(system),
        notifications: new NotificationProducer(notifications, notifySealerFromEnv(env)),
        appUrl: APP_URL.replace(/\/$/, ''),
      }),
      clock: systemClock,
    }),
    expire: new ExpireExports({ requests, storage, clock: systemClock }),
    eraser: new EraseOrganization({
      requests,
      eraser: new PrismaOrganizationEraser(system),
      revoke,
      billing,
      storage,
      clock: systemClock,
    }),
    schedule: new ScheduleErasures({
      requests,
      jobs: { erase: (requestId) => producer.erase({ requestId }) },
      clock: systemClock,
    }),
    media: new CleanUpMedia({ store: new PrismaMediaCleanupStore(system), storage, clock: systemClock }),
    requests,
  };
  return [
    {
      provide: GDPR_CLIENTS,
      useValue: { system, storage, notifications, gdpr, redis } satisfies GdprClients,
    },
    GdprClientsLifecycle,
    { provide: GDPR_PIPELINE, useValue: pipeline },
  ];
}
