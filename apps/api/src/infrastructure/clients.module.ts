import { S3Client } from '@aws-sdk/client-s3';
import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { sealerFromEnv } from '@smp/crypto';
import {
  AuditLogReadModel,
  createPrismaClient,
  createSystemPrismaClient,
  createTenantClient,
  PrismaTenancyUnitOfWork,
  TenancyReadModel,
  type PrismaClient,
  type SystemPrismaClient,
  type TenantPrismaClient,
} from '@smp/db';
import { S3Storage, storageConfigOf } from '@smp/media';
import {
  BILLING_QUEUE,
  GDPR_QUEUE,
  GdprProducer,
  MEDIA_QUEUE,
  MediaProducer,
  NOTIFICATIONS_QUEUE,
  NotificationProducer,
} from '@smp/queue';
import { XB_COMMANDS_QUEUE } from '@smp/x-browser';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { RequestOriginService, TenantContextService } from '../common/cls/tenant-context';
import type { ApiEnv } from '../config/api-env';
import { API_ENV } from '../config/config.module';

/** app_user without tenant context: health checks, Better Auth and withTenantTx. */
export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');
/** app_user with the tenant of the current request set in every operation. */
export const TENANT_DATABASE_CLIENT = Symbol('TENANT_DATABASE_CLIENT');
/**
 * app_system, past row-level security, only inside @SystemScope() methods: for the switches of
 * the platform admins, which belong to no workspace (guide step 6.1), and for what an
 * organization uses of its plan across its workspaces (guide step 7.4).
 */
export const SYSTEM_DATABASE_CLIENT = Symbol('SYSTEM_DATABASE_CLIENT');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const S3_CLIENT = Symbol('S3_CLIENT');
export const NOTIFICATIONS = Symbol('NOTIFICATIONS');
/** The storage of the media pipeline (StoragePort). */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
export const MEDIA_JOBS_QUEUE = Symbol('MEDIA_JOBS_QUEUE');
/** The commands of the browser worker of X; null where the deployment does not run it. */
export const XB_COMMANDS_JOBS_QUEUE = Symbol('XB_COMMANDS_JOBS_QUEUE');
export const BILLING_JOBS_QUEUE = Symbol('BILLING_JOBS_QUEUE');
/** The exports of the owners for the role "gdpr" (guide step 8.1). */
export const GDPR_JOBS_QUEUE = Symbol('GDPR_JOBS_QUEUE');
export const TENANCY_UNIT_OF_WORK = Symbol('TENANCY_UNIT_OF_WORK');
export const TENANCY_READ_MODEL = Symbol('TENANCY_READ_MODEL');
export const AUDIT_LOG_READ_MODEL = Symbol('AUDIT_LOG_READ_MODEL');

// Short timeouts keep a dead dependency from stalling the readiness probe.
const REDIS_TIMEOUT_MS = 2_000;

const queueLogger = new Logger('Queues');

/**
 * The producer side of a queue (guide steps 1.8 and 3.3). BullMQ owns the connection, so closing
 * the queue closes it too, also while it is still starting. Without the offline queue an
 * unreachable Redis fails the request at once instead of hanging it. Errors of the connection go
 * to the log instead of becoming unhandled.
 */
function producerQueue(name: string, env: ApiEnv): Queue {
  const queue = new Queue(name, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null, enableOfflineQueue: false },
  });
  queue.on('error', (error) => {
    queueLogger.warn({ err: error, queue: name }, 'queue.connection_error');
  });
  return queue;
}

/** How long a producer queue may still be starting when the application shuts down. */
const QUEUE_SETTLE_MS = 2_000;

/**
 * Closes a producer queue once its start has settled. A queue closed while it still asks Redis
 * for its version loses its listeners first, and the failed start then ends as an unhandled
 * rejection inside BullMQ.
 */
async function closeQueue(queue: Queue): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const settled = queue.waitUntilReady().then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUEUE_SETTLE_MS);
    }),
  ]);
  clearTimeout(timer);
  await queue.close();
}

/** Closes the connections when the application shuts down. */
class ClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
    @Inject(SYSTEM_DATABASE_CLIENT) private readonly system: SystemPrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(NOTIFICATIONS) private readonly notifications: Queue,
    @Inject(MEDIA_STORAGE) private readonly storage: S3Storage,
    @Inject(MEDIA_JOBS_QUEUE) private readonly media: Queue,
    @Inject(XB_COMMANDS_JOBS_QUEUE) private readonly xbCommands: Queue | null,
    @Inject(BILLING_JOBS_QUEUE) private readonly billing: Queue | null,
    @Inject(GDPR_JOBS_QUEUE) private readonly gdpr: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.s3.destroy();
    this.storage.destroy();
    await Promise.allSettled([
      this.prisma.$disconnect(),
      this.system.$disconnect(),
      this.redis.quit(),
      closeQueue(this.notifications),
      closeQueue(this.media),
      closeQueue(this.gdpr),
      ...(this.xbCommands ? [closeQueue(this.xbCommands)] : []),
      ...(this.billing ? [closeQueue(this.billing)] : []),
    ]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): PrismaClient => createPrismaClient(env.DATABASE_URL),
    },
    {
      provide: SYSTEM_DATABASE_CLIENT,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): SystemPrismaClient => createSystemPrismaClient(env.DATABASE_SYSTEM_URL),
    },
    {
      provide: TENANT_DATABASE_CLIENT,
      inject: [API_ENV, DATABASE_CLIENT, TenantContextService],
      useFactory: (env: ApiEnv, base: PrismaClient, tenant: TenantContextService): TenantPrismaClient =>
        createTenantClient(base, () => tenant.get(), {
          assertTenantFilter: env.NODE_ENV !== 'production',
        }),
    },
    {
      provide: REDIS_CLIENT,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Redis =>
        new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          connectTimeout: REDIS_TIMEOUT_MS,
          commandTimeout: REDIS_TIMEOUT_MS,
        }),
    },
    {
      provide: S3_CLIENT,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): S3Client =>
        new S3Client({
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
        }),
    },
    {
      provide: TENANCY_UNIT_OF_WORK,
      inject: [DATABASE_CLIENT, RequestOriginService],
      useFactory: (base: PrismaClient, origin: RequestOriginService) =>
        new PrismaTenancyUnitOfWork(base, () => origin.get()),
    },
    {
      provide: TENANCY_READ_MODEL,
      inject: [DATABASE_CLIENT],
      useFactory: (base: PrismaClient) => new TenancyReadModel(base),
    },
    {
      provide: AUDIT_LOG_READ_MODEL,
      inject: [DATABASE_CLIENT],
      useFactory: (base: PrismaClient) => new AuditLogReadModel(base),
    },
    {
      provide: NOTIFICATIONS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Queue => producerQueue(NOTIFICATIONS_QUEUE, env),
    },
    {
      // The emails of the jobs travel sealed with the token keyring (guide step 8.4).
      provide: NotificationProducer,
      inject: [NOTIFICATIONS, API_ENV],
      useFactory: (queue: Queue, env: ApiEnv) =>
        new NotificationProducer(queue, sealerFromEnv('tokens', env)),
    },
    {
      provide: MEDIA_STORAGE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): S3Storage => new S3Storage(storageConfigOf(env)),
    },
    {
      provide: MEDIA_JOBS_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Queue => producerQueue(MEDIA_QUEUE, env),
    },
    {
      provide: MediaProducer,
      inject: [MEDIA_JOBS_QUEUE],
      useFactory: (queue: Queue) => new MediaProducer(queue),
    },
    {
      // The start of a login of X (guide step 6.4), only where the browser worker runs.
      provide: XB_COMMANDS_JOBS_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Queue | null =>
        env.FEATURE_X_BROWSER_GLOBAL ? producerQueue(XB_COMMANDS_QUEUE, env) : null,
    },
    {
      // The webhooks of Stripe for the role "billing" (guide step 7.2), only with Stripe set up.
      provide: BILLING_JOBS_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Queue | null =>
        env.STRIPE_SECRET_KEY ? producerQueue(BILLING_QUEUE, env) : null,
    },
    {
      provide: GDPR_JOBS_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Queue => producerQueue(GDPR_QUEUE, env),
    },
    {
      provide: GdprProducer,
      inject: [GDPR_JOBS_QUEUE],
      useFactory: (queue: Queue) => new GdprProducer(queue),
    },
    ClientLifecycle,
  ],
  exports: [
    DATABASE_CLIENT,
    TENANT_DATABASE_CLIENT,
    SYSTEM_DATABASE_CLIENT,
    REDIS_CLIENT,
    S3_CLIENT,
    NotificationProducer,
    MEDIA_STORAGE,
    MediaProducer,
    XB_COMMANDS_JOBS_QUEUE,
    BILLING_JOBS_QUEUE,
    GdprProducer,
    TENANCY_UNIT_OF_WORK,
    TENANCY_READ_MODEL,
    AUDIT_LOG_READ_MODEL,
  ],
})
export class ClientsModule {}
