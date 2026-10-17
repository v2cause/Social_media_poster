import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { createStripeClient, StripeBillingGateway } from '@smp/billing';
import { ProcessStripeWebhook, systemClock, type BillingLock } from '@smp/core';
import {
  createSystemPrismaClient,
  PrismaBillingDirectory,
  PrismaSubscriptionSync,
  PrismaWebhookInbox,
  type SystemPrismaClient,
} from '@smp/db';
import { NOTIFICATIONS_QUEUE, NotificationProducer, withLock } from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import type { WorkerEnv } from '../worker-env';
import { BILLING_PIPELINE } from '../worker.tokens';
import { EmailBillingNotifier } from './billing-notifier';

// The adapters of the role "billing" (guide step 7.2, ADR 0034): Stripe, from which every webhook
// reads the subscription again; the database as app_system, because Stripe names a customer, not
// a tenant; the lock of a customer in Redis; and the queue of the role "notify" for the emails to
// the owners, whose links lead into the web app at APP_URL.

/** How long the lock of a customer lasts, and how long a webhook waits for it. */
const CUSTOMER_LOCK_TTL_MS = 60_000;
const CUSTOMER_LOCK_WAIT_MS = 30_000;

/** What the processor of the queue "billing" runs. */
export interface BillingPipeline {
  webhooks: ProcessStripeWebhook;
}

/** The connections of the role, closed when the worker shuts down. */
interface BillingClients {
  system: SystemPrismaClient;
  redis: Redis;
  notifications: Queue;
}

const BILLING_CLIENTS = Symbol('BILLING_CLIENTS');

@Injectable()
class BillingClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(BILLING_CLIENTS) private readonly clients: BillingClients) {}

  async onApplicationShutdown(): Promise<void> {
    await this.clients.notifications.close();
    this.clients.redis.disconnect();
    await this.clients.system.$disconnect();
  }
}

export function billingPipeline(env: WorkerEnv): Provider[] {
  const { STRIPE_SECRET_KEY, DATABASE_SYSTEM_URL, APP_URL } = env;
  if (!STRIPE_SECRET_KEY || !DATABASE_SYSTEM_URL || !APP_URL) {
    throw new Error(
      'Invalid configuration:\n  STRIPE_SECRET_KEY, DATABASE_SYSTEM_URL and APP_URL are required for the role "billing"',
    );
  }
  const stripe = createStripeClient({
    secretKey: STRIPE_SECRET_KEY,
    ...(env.STRIPE_API_BASE ? { apiBase: env.STRIPE_API_BASE } : {}),
  });
  const system = createSystemPrismaClient(DATABASE_SYSTEM_URL);
  // The lock fails instead of waiting while Redis is away; the job retries.
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  // The producer fails fast instead of queueing commands while Redis is away.
  const notifications = new Queue(NOTIFICATIONS_QUEUE, {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null, enableOfflineQueue: false },
  });
  const lock: BillingLock = {
    run: (key, work) =>
      withLock(redis, `lock:${key}`, CUSTOMER_LOCK_TTL_MS, () => work(), { waitMs: CUSTOMER_LOCK_WAIT_MS }),
  };
  const sync = new PrismaSubscriptionSync(system);
  const pipeline: BillingPipeline = {
    webhooks: new ProcessStripeWebhook({
      inbox: new PrismaWebhookInbox(system),
      gateway: new StripeBillingGateway(stripe),
      subscriptions: sync,
      sync,
      lock,
      notifier: new EmailBillingNotifier({
        directory: new PrismaBillingDirectory(system),
        notifications: new NotificationProducer(notifications),
        appUrl: APP_URL.replace(/\/$/, ''),
      }),
      clock: systemClock,
    }),
  };
  return [
    { provide: BILLING_CLIENTS, useValue: { system, redis, notifications } satisfies BillingClients },
    BillingClientsLifecycle,
    { provide: BILLING_PIPELINE, useValue: pipeline },
  ];
}
