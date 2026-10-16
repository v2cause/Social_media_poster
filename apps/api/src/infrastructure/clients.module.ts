import { S3Client } from '@aws-sdk/client-s3';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import {
  AuditLogReadModel,
  createPrismaClient,
  createTenantClient,
  PrismaTenancyUnitOfWork,
  TenancyReadModel,
  type PrismaClient,
  type TenantPrismaClient,
} from '@smp/db';
import { S3Storage, storageConfigOf } from '@smp/media';
import { MEDIA_QUEUE, MediaProducer, NOTIFICATIONS_QUEUE, NotificationProducer } from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { RequestOriginService, TenantContextService } from '../common/cls/tenant-context';
import type { ApiEnv } from '../config/api-env';
import { API_ENV } from '../config/config.module';

/** app_user without tenant context: health checks, Better Auth and withTenantTx. */
export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');
/** app_user with the tenant of the current request set in every operation. */
export const TENANT_DATABASE_CLIENT = Symbol('TENANT_DATABASE_CLIENT');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const S3_CLIENT = Symbol('S3_CLIENT');
export const NOTIFICATIONS = Symbol('NOTIFICATIONS');
/** The storage of the media pipeline (StoragePort). */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
export const MEDIA_JOBS_QUEUE = Symbol('MEDIA_JOBS_QUEUE');
export const TENANCY_UNIT_OF_WORK = Symbol('TENANCY_UNIT_OF_WORK');
export const TENANCY_READ_MODEL = Symbol('TENANCY_READ_MODEL');
export const AUDIT_LOG_READ_MODEL = Symbol('AUDIT_LOG_READ_MODEL');

// Short timeouts keep a dead dependency from stalling the readiness probe.
const REDIS_TIMEOUT_MS = 2_000;

/** Closes the connections when the application shuts down. */
class ClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(NOTIFICATIONS) private readonly notifications: Queue,
    @Inject(MEDIA_STORAGE) private readonly storage: S3Storage,
    @Inject(MEDIA_JOBS_QUEUE) private readonly media: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.s3.destroy();
    this.storage.destroy();
    await Promise.allSettled([
      this.prisma.$disconnect(),
      this.redis.quit(),
      this.notifications.close(),
      this.media.close(),
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
      // Producer side of the queue "notifications" (guide step 1.8). Without the offline queue an
      // unreachable Redis fails the request at once instead of hanging it.
      provide: NOTIFICATIONS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Queue =>
        new Queue(NOTIFICATIONS_QUEUE, {
          connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false }),
        }),
    },
    {
      provide: NotificationProducer,
      inject: [NOTIFICATIONS],
      useFactory: (queue: Queue) => new NotificationProducer(queue),
    },
    {
      provide: MEDIA_STORAGE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): S3Storage => new S3Storage(storageConfigOf(env)),
    },
    {
      // Producer side of the queue "media" (guide step 3.3), like the notifications above.
      provide: MEDIA_JOBS_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): Queue =>
        new Queue(MEDIA_QUEUE, {
          connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false }),
        }),
    },
    {
      provide: MediaProducer,
      inject: [MEDIA_JOBS_QUEUE],
      useFactory: (queue: Queue) => new MediaProducer(queue),
    },
    ClientLifecycle,
  ],
  exports: [
    DATABASE_CLIENT,
    TENANT_DATABASE_CLIENT,
    REDIS_CLIENT,
    S3_CLIENT,
    NotificationProducer,
    MEDIA_STORAGE,
    MediaProducer,
    TENANCY_UNIT_OF_WORK,
    TENANCY_READ_MODEL,
    AUDIT_LOG_READ_MODEL,
  ],
})
export class ClientsModule {}
