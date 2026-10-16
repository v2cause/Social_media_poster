import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { DeliverNotification } from '@smp/core';
import {
  createPrismaClient,
  PrismaNotificationDirectory,
  PrismaNotificationInbox,
  type PrismaClient,
} from '@smp/db';
import { createSmtpMailer, notificationEmailOf } from '@smp/emails';
import { NOTIFICATIONS_QUEUE, NotificationProducer } from '@smp/queue';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import type { WorkerEnv } from '../worker-env';
import { DELIVER_NOTIFICATION, MAIL_PORT } from '../worker.tokens';

// The adapters of the role "notify" (guide steps 1.8 and 4.9): SMTP for the emails; for the
// events of the outbox the database as app_user (the directory in the tenant of the event, the
// inbox as each recipient) and the producer that queues one email per event and recipient, with
// links into the web app at APP_URL.

const NOTIFY_CLIENTS = Symbol('NOTIFY_CLIENTS');

/** The connections of the role, closed when the worker shuts down. */
interface NotifyClients {
  database: PrismaClient;
  queue: Queue;
  connection: Redis;
}

@Injectable()
class NotifyClientsLifecycle implements OnApplicationShutdown {
  constructor(@Inject(NOTIFY_CLIENTS) private readonly clients: NotifyClients) {}

  async onApplicationShutdown(): Promise<void> {
    await this.clients.queue.close();
    this.clients.connection.disconnect();
    await this.clients.database.$disconnect();
  }
}

export function notifyPipeline(env: WorkerEnv): Provider[] {
  const { SMTP_URL, MAIL_FROM, APP_URL } = env;
  if (!SMTP_URL || !MAIL_FROM || !APP_URL) {
    throw new Error(
      'Invalid configuration:\n  SMTP_URL, MAIL_FROM and APP_URL are required for the role "notify"',
    );
  }
  const mailer = createSmtpMailer({ url: SMTP_URL, from: MAIL_FROM });
  // app_user: the directory sets the tenant of the event, the inbox the user of each recipient.
  const database = createPrismaClient(env.DATABASE_URL);
  // The producer fails fast instead of queueing commands while Redis is away; the job retries.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableOfflineQueue: false });
  const queue = new Queue(NOTIFICATIONS_QUEUE, { connection });
  const producer = new NotificationProducer(queue);
  const deliver = new DeliverNotification({
    directory: new PrismaNotificationDirectory(database),
    inbox: new PrismaNotificationInbox(database),
    mailer: {
      send: (email) =>
        producer.dispatchEventEmail(
          email.eventId,
          email.recipient.userId,
          email.recipient.email,
          notificationEmailOf(email, APP_URL),
        ),
    },
  });
  return [
    { provide: NOTIFY_CLIENTS, useValue: { database, queue, connection } satisfies NotifyClients },
    NotifyClientsLifecycle,
    { provide: MAIL_PORT, useValue: mailer },
    { provide: DELIVER_NOTIFICATION, useValue: deliver },
  ];
}
