import { BullModule } from '@nestjs/bullmq';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Provider,
  type Type,
} from '@nestjs/common';
import { ProcessAsset, RenderAttachedMedia, systemClock, uuidV7Ids } from '@smp/core';
import { createPrismaClient, PrismaMediaUnitOfWork, type PrismaClient } from '@smp/db';
import { S3Storage, SharpImageProcessor, storageConfigOf } from '@smp/media';
import { createLogger } from '@smp/observability';
import {
  ANALYTICS_QUEUE,
  MEDIA_QUEUE,
  NOTIFICATIONS_QUEUE,
  PUBLISH_QUEUE,
  SCHEDULER_QUEUE,
  TOKENS_QUEUE,
} from '@smp/queue';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';

import { HealthServer } from './health/health.server';
import { analyticsPipeline } from './infrastructure/analytics.providers';
import { notifyPipeline } from './infrastructure/notify.providers';
import { publisherPipeline } from './infrastructure/publisher.providers';
import { schedulerTicks } from './infrastructure/scheduler.providers';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { MediaProcessor } from './processors/media.processor';
import { NotifyProcessor } from './processors/notify.processor';
import { SchedulerProcessor } from './processors/scheduler.processor';
import { TokenRefreshProcessor } from './processors/token-refresh.processor';
import { PublishWorker } from './publisher/publish-worker';
import type { WorkerRole } from './roles';
import type { WorkerEnv } from './worker-env';
import { PROCESS_ASSET, RENDER_ATTACHED_MEDIA, WORKER_ENV } from './worker.tokens';

interface RoleWiring {
  queues: string[];
  /** The @Processor of each queue, or providers that run their own BullMQ worker. */
  processors: Type<unknown>[];
  /** Adapters only this role needs. */
  providers?: (env: WorkerEnv) => Provider[];
}

const MEDIA_CLIENTS = Symbol('MEDIA_CLIENTS');

/** The connections of the media pipeline, closed when the worker shuts down. */
interface MediaClients {
  database: PrismaClient;
  storage: S3Storage;
}

@Injectable()
class MediaClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MEDIA_CLIENTS) private readonly clients: MediaClients) {}

  async onApplicationShutdown(): Promise<void> {
    this.clients.storage.destroy();
    await this.clients.database.$disconnect();
  }
}

function mediaPipeline(env: WorkerEnv): Provider[] {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw new Error(
      'Invalid configuration:\n  S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required for the role "media"',
    );
  }
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
  const deps = {
    unitOfWork: new PrismaMediaUnitOfWork(database),
    storage,
    // One libvips thread per image; MEDIA_CONCURRENCY limits the images at once.
    processor: new SharpImageProcessor({ threads: 1 }),
    clock: systemClock,
    ids: uuidV7Ids,
  };
  return [
    { provide: MEDIA_CLIENTS, useValue: { database, storage } satisfies MediaClients },
    MediaClientsLifecycle,
    { provide: PROCESS_ASSET, useValue: new ProcessAsset(deps) },
    { provide: RENDER_ATTACHED_MEDIA, useValue: new RenderAttachedMedia(deps) },
  ];
}

// Processors per role. A role without an entry starts no processors yet.
const WIRING_BY_ROLE: Partial<Record<WorkerRole, RoleWiring>> = {
  scheduler: { queues: [SCHEDULER_QUEUE], processors: [SchedulerProcessor], providers: schedulerTicks },
  // token.refresh shares the adapters and the lock of a connection with the publish job.
  publisher: {
    queues: [PUBLISH_QUEUE, TOKENS_QUEUE],
    processors: [PublishWorker, TokenRefreshProcessor],
    providers: publisherPipeline,
  },
  analytics: { queues: [ANALYTICS_QUEUE], processors: [AnalyticsProcessor], providers: analyticsPipeline },
  media: { queues: [MEDIA_QUEUE], processors: [MediaProcessor], providers: mediaPipeline },
  notify: { queues: [NOTIFICATIONS_QUEUE], processors: [NotifyProcessor], providers: notifyPipeline },
};

@Module({})
export class WorkerModule {
  static forRoles(roles: WorkerRole[], env: WorkerEnv): DynamicModule {
    const wiring = roles.flatMap((role) => {
      const entry = WIRING_BY_ROLE[role];
      return entry ? [entry] : [];
    });

    const logger = createLogger({ service: 'worker', environment: env.NODE_ENV, level: env.LOG_LEVEL });
    // BullMQ workers block on their connection, so a failed command must not be retried forever.
    const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({ pinoHttp: { logger } }),
        BullModule.forRoot({ connection }),
        ...wiring.flatMap(({ queues }) => queues.map((name) => BullModule.registerQueue({ name }))),
      ],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        HealthServer,
        ...wiring.flatMap(({ processors, providers }) => [...processors, ...(providers?.(env) ?? [])]),
      ],
    };
  }
}
