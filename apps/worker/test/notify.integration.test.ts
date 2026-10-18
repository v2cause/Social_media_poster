import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sealerFromEnv } from '@smp/crypto';
import {
  liveEventChannel,
  NOTIFICATIONS_QUEUE,
  NOTIFY_DISPATCH,
  NotificationProducer,
  parseLiveEvent,
  type LiveEvent,
} from '@smp/queue';
import {
  startMailpit,
  startRedis,
  startTestDatabase,
  type StartedMailpit,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';
import { openedEmail, tokenKeys } from './support/sealed-email';

// Guide step 1.8, "Fertig, wenn": the invitation email arrives in Mailpit in both languages,
// sent by the worker role "notify" from the queue "notifications". Guide step 4.9: an event of
// the outbox reaches the managers of a connection in the app and by email, once, also when it
// is dispatched again; guide step 4.10: the new notification is announced as a live event.
// Guide step 8.4: an email waits in Redis sealed with the token keyring; one the keyring of the
// worker cannot open fails at once, as does one in the format from before the seal.

const org = randomUUID();
const workspace = randomUUID();
const owner = { id: randomUUID(), email: `owner-${randomUUID()}@demo.local` };
const TOKEN_KEYS = tokenKeys();
const invitation = {
  template: 'invitation' as const,
  url: 'http://localhost:3000/invite/token-for-the-test',
  organizationName: 'Acme GmbH',
  inviterName: 'Olivia Owner',
  role: 'EDITOR' as const,
};

describe('notify worker', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let subscriber: Redis | undefined;
  const live: LiveEvent[] = [];
  let mailpit: StartedMailpit | undefined;
  let worker: INestApplicationContext | undefined;
  let connection: Redis | undefined;
  let queue: Queue | undefined;
  let events: QueueEvents | undefined;

  const started = () => {
    if (!database || !mailpit || !connection || !queue || !events) {
      throw new Error('not started');
    }
    const producer = new NotificationProducer(queue, sealerFromEnv('tokens', TOKEN_KEYS));
    return { database, mailpit, connection, queue, events, producer };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  /** The emails Mailpit holds for the address. */
  const emailsTo = async (to: string): Promise<number> => {
    const response = await fetch(
      `${started().mailpit.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    const { messages } = (await response.json()) as { messages: unknown[] };
    return messages.length;
  };

  beforeAll(async () => {
    [database, redis, mailpit] = await Promise.all([startTestDatabase(), startRedis(), startMailpit()]);
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      WORKER_ROLES: 'notify',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      SMTP_URL: mailpit.smtpUrl,
      MAIL_FROM: 'noreply@smp.test',
      APP_URL: 'http://localhost:3000',
      ...TOKEN_KEYS,
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

    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Nordlicht', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'nordlicht-notify', 'Nordlicht', 'Europe/Berlin', 'de', now())`,
      [workspace, org],
    );
    await query(
      `INSERT INTO users (id, name, email, locale, updated_at) VALUES ($1, 'Olivia', $2, 'de', now())`,
      [owner.id, owner.email],
    );
    await query(
      `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'OWNER', now())`,
      [randomUUID(), org, owner.id],
    );
    subscriber = new Redis(redis.url);
    subscriber.on('message', (_channel: string, message: string) => {
      live.push(parseLiveEvent(JSON.parse(message)));
    });
    await subscriber.subscribe(liveEventChannel(workspace));
  }, 300_000);

  afterAll(async () => {
    subscriber?.disconnect();
    await events?.close();
    await queue?.close();
    connection?.disconnect();
    await worker?.close();
    await Promise.all([database?.stop(), redis?.stop(), mailpit?.stop()]);
  });

  it('sends the invitation in German and in English', async () => {
    const { producer, mailpit: mail } = started();
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

  it('tells the managers of a connection in the app and by email, once per event', async () => {
    const { producer, mailpit: mail, queue: notifications } = started();
    const connectionId = randomUUID();
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, status, external_user_id, display_name,
                                      access_token_sealed, access_token_expires_at, updated_at)
       VALUES ($1, $2, 'LINKEDIN', 'MOCK', 'NEEDS_REAUTH', 'mock-user', 'Mira', '\\x01', now(), now())`,
      [connectionId, workspace],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 'PROFILE', 'urn:li:person:mira', 'Mira Becker', now())`,
      [randomUUID(), workspace, connectionId],
    );
    const event = {
      eventId: randomUUID(),
      organizationId: org,
      workspaceId: workspace,
      request: { type: 'reauth-required' as const, connectionId, reason: 'EXPIRED', scheduledVariants: 2 },
    };

    await producer.dispatchEvent(event);
    const email = await mail.waitForMessage(owner.email);
    expect(email.Subject).toBe('Die Verbindung zu Mira Becker muss erneuert werden');
    expect(email.Text).toContain('2 geplante Posts sind betroffen.');
    expect(email.Text).toContain('http://localhost:3000/w/nordlicht-notify/accounts');
    const inbox = () =>
      query<{ type: string; workspace_id: string; payload: Record<string, unknown> }>(
        'SELECT type, workspace_id, payload FROM notification WHERE user_id = $1 AND event_id = $2',
        [owner.id, event.eventId],
      );
    expect(await inbox()).toEqual([
      {
        type: 'reauth-required',
        workspace_id: workspace,
        payload: expect.objectContaining({ accounts: ['Mira Becker'], scheduledVariants: 2 }) as unknown,
      },
    ]);
    const [stored] = await query<{ id: string }>(
      'SELECT id FROM notification WHERE user_id = $1 AND event_id = $2',
      [owner.id, event.eventId],
    );
    expect(live).toEqual([{ type: 'notification.created', id: stored?.id, userId: owner.id }]);

    // A second dispatch of the event, as after a failed commit of the relay, adds nothing.
    await producer.dispatchEvent(event);
    const jobs = await notifications.getJobs(['completed']);
    expect(jobs.filter((job) => job.id === `ntf.${event.eventId}`)).toHaveLength(1);
    await sleep(1_000);
    expect(await emailsTo(owner.email)).toBe(1);
    expect(await inbox()).toHaveLength(1);
    expect(live).toHaveLength(1);
  });

  it('keeps neither the address nor the link in Redis while an email waits', async () => {
    const { connection: redisClient } = started();
    const held = new Queue(`${NOTIFICATIONS_QUEUE}-held`, { connection: redisClient });
    try {
      await new NotificationProducer(held, sealerFromEnv('tokens', TOKEN_KEYS)).dispatchEmail(
        'held@example.test',
        { ...invitation, locale: 'en' },
      );
      const [job] = await held.getJobs(['waiting']);
      const stored = await redisClient.hgetall(`bull:${NOTIFICATIONS_QUEUE}-held:${job?.id ?? ''}`);
      expect(stored.data).toBeDefined();
      expect(JSON.stringify(stored)).not.toMatch(/held@example|token-for-the-test|Olivia/);
      expect(await openedEmail(TOKEN_KEYS, job?.data)).toMatchObject({
        to: 'held@example.test',
        email: { url: invitation.url },
      });
    } finally {
      await held.obliterate({ force: true });
      await held.close();
    }
  });

  it('fails an email sealed with another keyring at once instead of retrying it', async () => {
    const { queue: notifications, events: queueEvents } = started();
    const failure = new Promise<{ jobId: string; failedReason: string }>((resolve) => {
      queueEvents.once('failed', resolve);
    });
    await new NotificationProducer(notifications, sealerFromEnv('tokens', tokenKeys())).dispatchEmail(
      'foreign@example.test',
      { ...invitation, locale: 'en' },
    );
    const { jobId, failedReason } = await failure;
    expect(failedReason).toBe('unreadable notify.dispatch email');
    const failed = await notifications.getJob(jobId);
    expect(await failed?.getState()).toBe('failed');
    expect(failed?.attemptsMade).toBe(1);
    expect(await emailsTo('foreign@example.test')).toBe(0);
  });

  it('fails an invalid payload at once instead of retrying it', async () => {
    const { queue: notifications, events: queueEvents } = started();
    const job = await notifications.add(NOTIFY_DISPATCH, { channel: 'sms', to: 'x' }, { attempts: 5 });
    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow(/invalid notify.dispatch payload/);
    const failed = await notifications.getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(1);

    // An email in the clear, as queued before the seal, is no valid payload any more.
    const plain = await notifications.add(
      NOTIFY_DISPATCH,
      { channel: 'email', to: 'plain@example.test', email: { ...invitation, locale: 'en' } },
      { attempts: 5 },
    );
    await expect(plain.waitUntilFinished(queueEvents)).rejects.toThrow(/invalid notify.dispatch payload/);
    expect(await emailsTo('plain@example.test')).toBe(0);
  });
});
