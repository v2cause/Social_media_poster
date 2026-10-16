import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { RewrapSecrets, systemClock } from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import {
  createSystemPrismaClient,
  PrismaOutboxRelay,
  PrismaPublishScheduler,
  PrismaSealedSecretStore,
  type SystemPrismaClient,
} from '@smp/db';
import {
  LiveEventPublisher,
  NOTIFICATIONS_QUEUE,
  NotificationProducer,
  PUBLISH_QUEUE,
  PublishProducer,
} from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import type { TickHandlers } from '../processors/scheduler.processor';
import { Maintenance } from '../scheduler/maintenance';
import { OutboxDispatcher } from '../scheduler/outbox-dispatcher';
import { PublishTick } from '../scheduler/publish-tick';
import { Sweeper } from '../scheduler/sweeper';
import type { WorkerEnv } from '../worker-env';
import { TICK_HANDLERS } from '../worker.tokens';

// The adapters of the role "scheduler" (guide steps 4.2, 4.3, 4.7 and 4.9): the system client
// for the scans across workspaces, the producers of the jobs the ticks add, and the tick handlers.

const SCHEDULER_CLIENTS = Symbol('SCHEDULER_CLIENTS');
/** Variants per claim of tick.publish and per scan of the sweeper. */
const PUBLISH_BATCH = 500;

/** The connections of the scheduler, closed when the worker shuts down. */
interface SchedulerClients {
  system: SystemPrismaClient;
  queues: Queue[];
  producers: Redis;
  live: Redis;
}

@Injectable()
class SchedulerClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SCHEDULER_CLIENTS) private readonly clients: SchedulerClients) {}

  async onApplicationShutdown(): Promise<void> {
    for (const queue of this.clients.queues) {
      await queue.close();
    }
    // A queue leaves a connection it was given open.
    this.clients.producers.disconnect();
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
  // Producers share a connection that fails fast instead of queueing commands while Redis is
  // away, so the relay keeps the event and tries again.
  const producers = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false });
  const publishQueue = new Queue(PUBLISH_QUEUE, { connection: producers });
  const notificationsQueue = new Queue(NOTIFICATIONS_QUEUE, { connection: producers });
  // Live events go out on a plain connection that fails fast as well.
  const live = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  const outbox = new PrismaOutboxRelay(system);
  const publishProducer = new PublishProducer(publishQueue);
  const dispatcher = new OutboxDispatcher({
    publish: publishProducer,
    live: new LiveEventPublisher(live),
    notifications: new NotificationProducer(notificationsQueue),
  });
  const plans = new PrismaPublishScheduler(system, { batchSize: PUBLISH_BATCH });
  const publishTick = new PublishTick({
    plans,
    producer: publishProducer,
    now: () => systemClock.now().getTime(),
    batchSize: PUBLISH_BATCH,
  });
  const sweeper = new Sweeper({ plans, queue: publishQueue, producer: publishProducer });
  const maintenance = new Maintenance({
    rewrapSecrets: new RewrapSecrets({ store: new PrismaSealedSecretStore(system), rewrappers: sealers }),
    outbox,
  });
  const handlers: TickHandlers = {
    'tick.publish': () => publishTick.run(),
    'tick.sweep-queued': () => sweeper.run(),
    'tick.outbox-relay': async () => ({ ...(await outbox.relay((event) => dispatcher.dispatch(event))) }),
    'tick.maintenance': async () => {
      const { secrets, outboxPurged } = await maintenance.run();
      return { ...secrets, outboxPurged };
    },
  };
  return [
    {
      provide: SCHEDULER_CLIENTS,
      useValue: {
        system,
        queues: [publishQueue, notificationsQueue],
        producers,
        live,
      } satisfies SchedulerClients,
    },
    SchedulerClientsLifecycle,
    { provide: TICK_HANDLERS, useValue: handlers },
  ];
}
