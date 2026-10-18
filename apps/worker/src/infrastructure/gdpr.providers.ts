import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { ExpireExports, ExportOrganizationData, systemClock, type GdprRequestRunner } from '@smp/core';
import {
  createSystemPrismaClient,
  PrismaBillingDirectory,
  PrismaGdprRequestRunner,
  PrismaOrganizationDataSource,
  type SystemPrismaClient,
} from '@smp/db';
import { S3Storage, storageConfigOf } from '@smp/media';
import { NOTIFICATIONS_QUEUE, NotificationProducer } from '@smp/queue';
import { Queue } from 'bullmq';

import type { WorkerEnv } from '../worker-env';
import { GDPR_PIPELINE } from '../worker.tokens';
import { EmailGdprNotifier } from './gdpr-notifier';
import { ZipExportArchives } from './zip-export-archives';

// The adapters of the role "gdpr" (guide step 8.1, ADR 0036): the database as app_system,
// because an export reads every workspace of an organization; the object storage, which takes
// the archive while it is written and holds the originals of the media library; and the queue of
// the role "notify" for the email to the owner, whose link leads into the web app at APP_URL.

/** What the processor of the queue "gdpr" runs. */
export interface GdprPipeline {
  exporter: ExportOrganizationData;
  expire: ExpireExports;
  requests: GdprRequestRunner;
}

/** The connections of the role, closed when the worker shuts down. */
interface GdprClients {
  system: SystemPrismaClient;
  storage: S3Storage;
  notifications: Queue;
}

const GDPR_CLIENTS = Symbol('GDPR_CLIENTS');

@Injectable()
class GdprClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(GDPR_CLIENTS) private readonly clients: GdprClients) {}

  async onApplicationShutdown(): Promise<void> {
    await this.clients.notifications.close();
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
  // The producer fails fast instead of queueing commands while Redis is away.
  const notifications = new Queue(NOTIFICATIONS_QUEUE, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null, enableOfflineQueue: false },
  });
  const requests = new PrismaGdprRequestRunner(system);
  const pipeline: GdprPipeline = {
    exporter: new ExportOrganizationData({
      requests,
      source: new PrismaOrganizationDataSource(system),
      archives: new ZipExportArchives(storage, () => systemClock.now()),
      storage,
      notifier: new EmailGdprNotifier({
        directory: new PrismaBillingDirectory(system),
        notifications: new NotificationProducer(notifications),
        appUrl: APP_URL.replace(/\/$/, ''),
      }),
      clock: systemClock,
    }),
    expire: new ExpireExports({ requests, storage, clock: systemClock }),
    requests,
  };
  return [
    { provide: GDPR_CLIENTS, useValue: { system, storage, notifications } satisfies GdprClients },
    GdprClientsLifecycle,
    { provide: GDPR_PIPELINE, useValue: pipeline },
  ];
}
