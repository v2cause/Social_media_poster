import { createServer, type Server } from 'node:http';

import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@smp/db';
import Redis from 'ioredis';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';

import { metricsRegistry } from '../metrics';
import type { WorkerEnv } from '../worker-env';
import { WORKER_ENV } from '../worker.tokens';
import { type ReadinessCheck, routeHealthRequest } from './health-routes';

/** Serves /health/live, /health/ready and /metrics on the health port. The worker has no public API. */
@Injectable()
export class HealthServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private server: Server | undefined;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @InjectPinoLogger(HealthServer.name) private readonly logger: PinoLogger,
  ) {
    this.prisma = createPrismaClient(env.DATABASE_URL);
    this.redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
  }

  onApplicationBootstrap(): void {
    const checks: ReadinessCheck[] = [
      {
        name: 'redis',
        run: async () => {
          await this.redis.ping();
        },
      },
      {
        name: 'database',
        run: async () => {
          await this.prisma.$queryRaw`SELECT 1`;
        },
      },
    ];

    this.server = createServer((request, response) => {
      routeHealthRequest(request.url ?? '', checks, metricsRegistry).then(
        (result) => {
          response.writeHead(result.status, { 'content-type': result.contentType });
          response.end(result.body);
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
    this.server.listen(this.env.WORKER_HEALTH_PORT, '0.0.0.0');
    this.logger.info({ port: this.env.WORKER_HEALTH_PORT }, 'worker.health.listening');
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    await Promise.allSettled([this.prisma.$disconnect(), this.redis.quit()]);
  }
}
