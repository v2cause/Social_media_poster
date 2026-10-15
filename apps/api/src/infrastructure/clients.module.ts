import { S3Client } from '@aws-sdk/client-s3';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@smp/db';
import Redis from 'ioredis';

import type { ApiEnv } from '../config/api-env';
import { API_ENV } from '../config/config.module';

export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const S3_CLIENT = Symbol('S3_CLIENT');

// Short timeouts keep a dead dependency from stalling the readiness probe.
const REDIS_TIMEOUT_MS = 2_000;

/** Closes the connections when the application shuts down. */
class ClientLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.s3.destroy();
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
    ClientLifecycle,
  ],
  exports: [DATABASE_CLIENT, REDIS_CLIENT, S3_CLIENT],
})
export class ClientsModule {}
