import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { createLogger } from '@smp/observability';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';

import { HealthServer } from './health/health.server';
import { NoopProcessor, SCHEDULER_QUEUE } from './processors/noop.processor';
import type { WorkerRole } from './roles';
import type { WorkerEnv } from './worker-env';
import { WORKER_ENV } from './worker.tokens';

interface RoleWiring {
  queue: string;
  processor: Type<unknown>;
}

// Processors per role. A role without an entry starts no processors yet.
const WIRING_BY_ROLE: Partial<Record<WorkerRole, RoleWiring>> = {
  scheduler: { queue: SCHEDULER_QUEUE, processor: NoopProcessor },
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
        ...wiring.map(({ queue }) => BullModule.registerQueue({ name: queue })),
      ],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        HealthServer,
        ...wiring.map(({ processor }) => processor),
      ],
    };
  }
}
