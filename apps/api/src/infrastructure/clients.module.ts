import { S3Client } from '@aws-sdk/client-s3';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { MailPort } from '@smp/core';
import {
  AuditLogReadModel,
  createPrismaClient,
  createTenantClient,
  PrismaTenancyUnitOfWork,
  TenancyReadModel,
  type PrismaClient,
  type TenantPrismaClient,
} from '@smp/db';
import { createSmtpMailer } from '@smp/emails';
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
export const MAIL_PORT = Symbol('MAIL_PORT');
export const TENANCY_UNIT_OF_WORK = Symbol('TENANCY_UNIT_OF_WORK');
export const TENANCY_READ_MODEL = Symbol('TENANCY_READ_MODEL');
export const AUDIT_LOG_READ_MODEL = Symbol('AUDIT_LOG_READ_MODEL');

type ClosableMailPort = MailPort & { close(): void };

// Short timeouts keep a dead dependency from stalling the readiness probe.
const REDIS_TIMEOUT_MS = 2_000;

/** Closes the connections when the application shuts down. */
class ClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(MAIL_PORT) private readonly mail: ClosableMailPort,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.s3.destroy();
    this.mail.close();
    await Promise.allSettled([this.prisma.$disconnect(), this.redis.quit()]);
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
      provide: MAIL_PORT,
      inject: [API_ENV],
      useFactory: (env: ApiEnv): ClosableMailPort =>
        createSmtpMailer({ url: env.SMTP_URL, from: env.MAIL_FROM }),
    },
    ClientLifecycle,
  ],
  exports: [
    DATABASE_CLIENT,
    TENANT_DATABASE_CLIENT,
    REDIS_CLIENT,
    S3_CLIENT,
    MAIL_PORT,
    TENANCY_UNIT_OF_WORK,
    TENANCY_READ_MODEL,
    AUDIT_LOG_READ_MODEL,
  ],
})
export class ClientsModule {}
