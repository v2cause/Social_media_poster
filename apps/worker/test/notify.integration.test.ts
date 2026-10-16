import 'reflect-metadata';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NOTIFICATIONS_QUEUE, NOTIFY_DISPATCH, NotificationProducer } from '@smp/queue';
import { startMailpit, startRedis, type StartedMailpit, type StartedRedis } from '@smp/testing';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide step 1.8, "Fertig, wenn": the invitation email arrives in Mailpit in both languages,
// sent by the worker role "notify" from the queue "notifications".

describe('notify worker', () => {
  let redis: StartedRedis | undefined;
  let mailpit: StartedMailpit | undefined;
  let worker: INestApplicationContext | undefined;
  let connection: Redis | undefined;
  let queue: Queue | undefined;
  let events: QueueEvents | undefined;

  const started = () => {
    if (!mailpit || !queue || !events) {
      throw new Error('not started');
    }
    return { mailpit, queue, events, producer: new NotificationProducer(queue) };
  };

  beforeAll(async () => {
    [redis, mailpit] = await Promise.all([startRedis(), startMailpit()]);
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      WORKER_ROLES: 'notify',
      WORKER_HEALTH_PORT: String(40_000 + Math.floor(Math.random() * 10_000)),
      REDIS_URL: redis.url,
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:9/unused',
      SMTP_URL: mailpit.smtpUrl,
      MAIL_FROM: 'noreply@smp.test',
    });
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoles(['notify'], env), {
      logger: false,
    });
    await worker.init();

    connection = new Redis(redis.url, { maxRetriesPerRequest: null });
    queue = new Queue(NOTIFICATIONS_QUEUE, { connection });
    events = new QueueEvents(NOTIFICATIONS_QUEUE, {
      connection: new Redis(redis.url, { maxRetriesPerRequest: null }),
    });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events?.close();
    await queue?.close();
    connection?.disconnect();
    await worker?.close();
    await Promise.all([redis?.stop(), mailpit?.stop()]);
  });

  it('sends the invitation in German and in English', async () => {
    const { producer, mailpit: mail } = started();
    const invitation = {
      template: 'invitation' as const,
      url: 'http://localhost:3000/invite/token-for-the-test',
      organizationName: 'Acme GmbH',
      inviterName: 'Olivia Owner',
      role: 'EDITOR' as const,
    };
    await producer.dispatchEmail('deutsch@example.test', { ...invitation, locale: 'de' });
    await producer.dispatchEmail('english@example.test', { ...invitation, locale: 'en' });

    const de = await mail.waitForMessage('deutsch@example.test');
    expect(de.Subject).toBe('Einladung zu Acme GmbH');
    expect(de.Text).toContain('Olivia Owner hat Sie eingeladen');
    expect(de.Text).toContain('Ihre Rolle: Redakteur.');
    expect(de.Text).toContain('http://localhost:3000/invite/token-for-the-test');
    expect(de.HTML).toContain('lang="de"');

    const en = await mail.waitForMessage('english@example.test');
    expect(en.Subject).toBe('Invitation to Acme GmbH');
    expect(en.Text).toContain('Olivia Owner invited you');
    expect(en.Text).toContain('Your role: Editor.');
  });

  it('fails an invalid payload at once instead of retrying it', async () => {
    const { queue: notifications, events: queueEvents } = started();
    const job = await notifications.add(NOTIFY_DISPATCH, { channel: 'sms', to: 'x' }, { attempts: 5 });
    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow(/invalid notify.dispatch payload/);
    const failed = await notifications.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(1);
  });
});
