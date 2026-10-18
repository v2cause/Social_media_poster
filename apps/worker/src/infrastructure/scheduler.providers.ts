import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { AnnounceReadOnly, MonitorTokens, RewrapSecrets, systemClock } from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaExpiringConnectionScanner,
  PrismaBillingDirectory,
  PrismaMetricsPlanScanner,
  PrismaOutboxRelay,
  PrismaPublishScheduler,
  PrismaReadOnlyNotices,
  PrismaSealedSecretStore,
  PrismaTokenMaintenanceUnitOfWork,
  PrismaUsageReportStore,
  PrismaXBrowserOperations,
  type PrismaClient,
  type SystemPrismaClient,
} from '@smp/db';
import { BullXbCommandBus } from '@smp/platform-adapters';
import {
  ANALYTICS_QUEUE,
  AnalyticsProducer,
  BILLING_QUEUE,
  BillingProducer,
  GDPR_QUEUE,
  GdprProducer,
  LiveEventPublisher,
  NOTIFICATIONS_QUEUE,
  NotificationProducer,
  PUBLISH_QUEUE,
  PublishProducer,
  TokenProducer,
  TOKENS_QUEUE,
} from '@smp/queue';
import { XB_COMMANDS_QUEUE } from '@smp/x-browser';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';

import type { TickHandlers } from '../processors/scheduler.processor';
import { AnalyticsTick } from '../scheduler/analytics-tick';
import { Maintenance } from '../scheduler/maintenance';
import { OutboxDispatcher } from '../scheduler/outbox-dispatcher';
import { PublishTick } from '../scheduler/publish-tick';
import { Sweeper } from '../scheduler/sweeper';
import { UsageReportTick } from '../scheduler/usage-report-tick';
import { XBrowserCanaryTick } from '../scheduler/x-browser-canary';
import type { WorkerEnv } from '../worker-env';
import { TICK_HANDLERS } from '../worker.tokens';
import { EmailBillingNotifier } from './billing-notifier';

// The adapters of the role "scheduler" (guide steps 4.2, 4.3, 4.7, 4.9, 5.2, 6.5, 7.3, 7.4 and
// 8.1): the system client for the scans across workspaces, app_user for the changes of the token
// monitor in the tenant of each connection, the producers of the jobs the ticks add, the commands
// of the daily canary of the X browser, and the tick handlers. The daily usage reports run where
// Stripe is set up (STRIPE_SECRET_KEY); the notices of read-only access, whose links lead into
// the web app, where APP_URL is set.

const SCHEDULER_CLIENTS = Symbol('SCHEDULER_CLIENTS');
/** Variants per claim of tick.publish and per scan of the sweeper. */
const PUBLISH_BATCH = 500;

/** The connections of the scheduler, closed when the worker shuts down. */
interface SchedulerClients {
  system: SystemPrismaClient;
  database: PrismaClient;
  queues: Queue[];
  events: QueueEvents[];
  producers: Redis;
  live: Redis;
}

@Injectable()
class SchedulerClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SCHEDULER_CLIENTS) private readonly clients: SchedulerClients) {}

  async onApplicationShutdown(): Promise<void> {
    for (const events of this.clients.events) {
      await events.close();
    }
    for (const queue of this.clients.queues) {
      await queue.close();
    }
    // A queue leaves a connection it was given open.
    this.clients.producers.disconnect();
    this.clients.live.disconnect();
    await this.clients.database.$disconnect();
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
  // app_user with the tenant of each connection: row-level security applies to the monitor too.
  const database = createPrismaClient(env.DATABASE_URL);
  // Producers share a connection that fails fast instead of queueing commands while Redis is
  // away, so the relay keeps the event and tries again.
  const producers = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false });
  const publishQueue = new Queue(PUBLISH_QUEUE, { connection: producers });
  const notificationsQueue = new Queue(NOTIFICATIONS_QUEUE, { connection: producers });
  const tokensQueue = new Queue(TOKENS_QUEUE, { connection: producers });
  const analyticsQueue = new Queue(ANALYTICS_QUEUE, { connection: producers });
  const gdprQueue = new Queue(GDPR_QUEUE, { connection: producers });
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
  const tokenProducer = new TokenProducer(tokensQueue);
  const tokens = new MonitorTokens({
    scanner: new PrismaExpiringConnectionScanner(system),
    unitOfWork: new PrismaTokenMaintenanceUnitOfWork(database),
    refreshes: { request: (job) => tokenProducer.refresh(job) },
    clock: systemClock,
  });
  const analytics = new AnalyticsTick({
    scanner: new PrismaMetricsPlanScanner(system),
    producer: new AnalyticsProducer(analyticsQueue),
    now: () => systemClock.now(),
  });
  // The canary sends its command like the adapter of X does and waits for the outcome.
  const canary =
    env.FEATURE_X_BROWSER_GLOBAL && env.XB_CANARY_ACCOUNT_ID
      ? {
          queue: new Queue(XB_COMMANDS_QUEUE, { connection: producers }),
          events: new QueueEvents(XB_COMMANDS_QUEUE, { connection: { url: env.REDIS_URL } }),
          accountId: env.XB_CANARY_ACCOUNT_ID,
        }
      : null;
  const canaryTick = canary
    ? new XBrowserCanaryTick({
        accounts: new PrismaXBrowserOperations(system),
        bus: new BullXbCommandBus(canary.queue, canary.events),
        accountId: canary.accountId,
        now: () => systemClock.now(),
      })
    : null;
  const billingQueue = env.STRIPE_SECRET_KEY ? new Queue(BILLING_QUEUE, { connection: producers }) : null;
  const usageTick = billingQueue
    ? new UsageReportTick({
        store: new PrismaUsageReportStore(system),
        producer: new BillingProducer(billingQueue),
        now: () => systemClock.now(),
      })
    : null;
  // A trial ends without Stripe too, so the notice needs only the link into the web app.
  const readOnly = env.APP_URL
    ? new AnnounceReadOnly({
        notices: new PrismaReadOnlyNotices(system),
        notifier: new EmailBillingNotifier({
          directory: new PrismaBillingDirectory(system),
          notifications: new NotificationProducer(notificationsQueue),
          appUrl: env.APP_URL.replace(/\/$/, ''),
        }),
        clock: systemClock,
      })
    : null;
  const gdprProducer = new GdprProducer(gdprQueue);
  const handlers: TickHandlers = {
    'tick.publish': () => publishTick.run(),
    'tick.sweep-queued': () => sweeper.run(),
    'tick.outbox-relay': async () => ({ ...(await outbox.relay((event) => dispatcher.dispatch(event))) }),
    'tick.tokens': async () => ({ ...(await tokens.execute()) }),
    'tick.analytics': () => analytics.postMetrics(),
    'tick.account-metrics': () => analytics.accountMetrics(),
    'tick.maintenance': async () => {
      const { secrets, outboxPurged } = await maintenance.run();
      return { ...secrets, outboxPurged, ...(await analytics.nightlyRollups()) };
    },
    ...(canaryTick ? { 'tick.xb-canary': () => canaryTick.run() } : {}),
    ...(usageTick ? { 'tick.usage-report': () => usageTick.run() } : {}),
    ...(readOnly ? { 'tick.read-only': async () => ({ ...(await readOnly.execute()) }) } : {}),
    // The role "gdpr" reaches the object storage; the tick only hands it the sweep.
    'tick.gdpr': async () => {
      await gdprProducer.sweep();
      return {};
    },
  };
  return [
    {
      provide: SCHEDULER_CLIENTS,
      useValue: {
        system,
        database,
        queues: [
          publishQueue,
          notificationsQueue,
          tokensQueue,
          analyticsQueue,
          gdprQueue,
          ...(canary ? [canary.queue] : []),
          ...(billingQueue ? [billingQueue] : []),
        ],
        events: canary ? [canary.events] : [],
        producers,
        live,
      } satisfies SchedulerClients,
    },
    SchedulerClientsLifecycle,
    { provide: TICK_HANDLERS, useValue: handlers },
  ];
}
