import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { createSmtpMailer } from '@smp/emails';
import { createLogger } from '@smp/observability';
import { NOTIFICATIONS_QUEUE } from '@smp/queue';
import Redis from 'ioredis';
import { LoggerModule } from 'nestjs-pino';

import { HealthServer } from './health/health.server';
import { NoopProcessor, SCHEDULER_QUEUE } from './processors/noop.processor';
import { NotifyProcessor } from './processors/notify.processor';
import type { WorkerRole } from './roles';
import type { WorkerEnv } from './worker-env';
import { MAIL_PORT, WORKER_ENV } from './worker.tokens';

interface RoleWiring {
  queue: string;
  processor: Type<unknown>;
  /** Adapters only this role needs. */
  providers?: (env: WorkerEnv) => Provider[];
}

function smtpMailer(env: WorkerEnv): Provider[] {
  if (!env.SMTP_URL || !env.MAIL_FROM) {
    throw new Error('Invalid configuration:\n  SMTP_URL and MAIL_FROM are required for the role "notify"');
  }
  const mailer = createSmtpMailer({ url: env.SMTP_URL, from: env.MAIL_FROM });
  return [{ provide: MAIL_PORT, useValue: mailer }];
}

// Processors per role. A role without an entry starts no processors yet.
const WIRING_BY_ROLE: Partial<Record<WorkerRole, RoleWiring>> = {
  scheduler: { queue: SCHEDULER_QUEUE, processor: NoopProcessor },
  notify: { queue: NOTIFICATIONS_QUEUE, processor: NotifyProcessor, providers: smtpMailer },
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
        ...wiring.flatMap(({ processor, providers }) => [processor, ...(providers?.(env) ?? [])]),
      ],
    };
  }
}
