import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { RewrapSecrets } from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import {
  createSystemPrismaClient,
  PrismaOutboxRelay,
  PrismaSealedSecretStore,
  type SystemPrismaClient,
} from '@smp/db';
import { LiveEventPublisher, PUBLISH_QUEUE, PublishProducer } from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import type { TickHandlers } from '../processors/scheduler.processor';
import { Maintenance } from '../scheduler/maintenance';
import { OutboxDispatcher } from '../scheduler/outbox-dispatcher';
import type { WorkerEnv } from '../worker-env';
import { TICK_HANDLERS } from '../worker.tokens';

// The adapters of the role "scheduler" (guide steps 4.2 and 4.3): the system client for the scans
// across workspaces, the producers of the jobs the ticks add, and the tick handlers.

const SCHEDULER_CLIENTS = Symbol('SCHEDULER_CLIENTS');

/** The connections of the scheduler, closed when the worker shuts down. */
interface SchedulerClients {
  system: SystemPrismaClient;
  publishQueue: Queue;
  live: Redis;
}

@Injectable()
class SchedulerClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SCHEDULER_CLIENTS) private readonly clients: SchedulerClients) {}

  async onApplicationShutdown(): Promise<void> {
    await this.clients.publishQueue.close();
    this.clients.live.disconnect();
    await this.clients.system.$disconnect();
  }
}

export function schedulerTicks(env: WorkerEnv): Provider[] {
  if (!env.DATABASE_SYSTEM_URL) {
    throw new Error('Invalid configuration:\n  DATABASE_SYSTEM_URL is required for the role "scheduler"');
  }
  // The keyrings are checked at the start, not at night when the re-wrap first needs them.
  const sealers = { tokens: sealerFromEnv('tokens', env), sessions: sealerFromEnv('sessions', env) };
  // app_system for the scans across workspaces; every use runs inside a system scope.
  const system = createSystemPrismaClient(env.DATABASE_SYSTEM_URL);
  // Producers get a connection of their own that fails fast instead of queueing commands while
  // Redis is away, so the relay keeps the event and tries again.
  const publishQueue = new Queue(PUBLISH_QUEUE, {
    connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false }),
  });
  // Live events go out on a plain connection that fails fast as well.
  const live = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  const outbox = new PrismaOutboxRelay(system);
  const dispatcher = new OutboxDispatcher({
    publish: new PublishProducer(publishQueue),
    live: new LiveEventPublisher(live),
  });
  const maintenance = new Maintenance({
    rewrapSecrets: new RewrapSecrets({ store: new PrismaSealedSecretStore(system), rewrappers: sealers }),
    outbox,
  });
  const handlers: TickHandlers = {
    'tick.outbox-relay': async () => ({ ...(await outbox.relay((event) => dispatcher.dispatch(event))) }),
    'tick.maintenance': async () => {
      const { secrets, outboxPurged } = await maintenance.run();
      return { ...secrets, outboxPurged };
    },
  };
  return [
    { provide: SCHEDULER_CLIENTS, useValue: { system, publishQueue, live } satisfies SchedulerClients },
    SchedulerClientsLifecycle,
    { provide: TICK_HANDLERS, useValue: handlers },
  ];
}
