import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NOTIFICATIONS_QUEUE, SCHEDULER_QUEUE, type Tick } from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TickHandlers } from '../src/processors/scheduler.processor';
import { parseRoles } from '../src/roles';
import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';
import { TICK_HANDLERS } from '../src/worker.tokens';
import { openedEmail, tokenKeys } from './support/sealed-email';

// Guide step 7.4 through the role "scheduler": with APP_URL the tick tick.read-only tells the
// owners of an organization once that it became read-only, with the reason and a link to the
// billing page; an organization still in its trial hears nothing. Without APP_URL the tick goes.
// A tick with an interval runs once at the start of the role, so the test waits for that run
// through the queue instead of racing it with a call of its own.

const TOKEN_KEYS = tokenKeys();

describe('the notice of read-only access in the role "scheduler"', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let notifications: Queue | undefined;
  let ticks: QueueEvents | undefined;
  const opened: INestApplicationContext[] = [];

  const started = () => {
    if (!database || !redis || !notifications || !ticks) {
      throw new Error('not started');
    }
    return { database, redis, notifications, ticks };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const scheduler = async (appUrl?: string): Promise<INestApplicationContext> => {
    const key = (): string => `kek-test:${randomBytes(32).toString('base64')}`;
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'scheduler',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: started().redis.url,
      DATABASE_URL: started().database.url('app_user'),
      DATABASE_SYSTEM_URL: started().database.url('app_system'),
      ...TOKEN_KEYS,
      SESSION_KEKS: key(),
      SESSION_KEK_ACTIVE: 'kek-test',
      ...(appUrl ? { APP_URL: appUrl } : {}),
    });
    const context = await NestFactory.createApplicationContext(
      WorkerModule.forRoles(parseRoles(env.WORKER_ROLES), env),
      { logger: false },
    );
    opened.push(context);
    return context;
  };
  const schedulerKeys = async (): Promise<string[]> => {
    const queue = new Queue(SCHEDULER_QUEUE, { connection: { url: started().redis.url } });
    try {
      return (await queue.getJobSchedulers()).map((entry) => entry.key).sort();
    } finally {
      await queue.close();
    }
  };
  /** What the next run of a tick through the queue of the role returns. */
  const nextRun = (tick: Tick): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const ours = (jobId: string): boolean => jobId.startsWith(`repeat:${tick}:`);
      started().ticks.on('completed', ({ jobId, returnvalue }) => {
        if (ours(jobId)) {
          resolve(returnvalue);
        }
      });
      started().ticks.on('failed', ({ jobId, failedReason }) => {
        if (ours(jobId)) {
          reject(new Error(failedReason));
        }
      });
    });
  /** An organization with one verified owner and a subscription read-only from the given moment. */
  const organization = async (status: string, readOnlyAt: string): Promise<{ id: string; owner: string }> => {
    const id = randomUUID();
    const owner = randomUUID();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Nordlicht GmbH', now())`, [id]);
    await query(
      `INSERT INTO users (id, name, email, email_verified, locale, timezone, updated_at)
       VALUES ($1, 'Olivia', $2, true, 'en', 'America/New_York', now())`,
      [owner, `olivia-${owner}@nordlicht.test`],
    );
    await query(
      `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES ($1, $2, $3, 'OWNER', now())`,
      [randomUUID(), id, owner],
    );
    await query(
      `INSERT INTO subscription (id, organization_id, plan_key, status, read_only_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'trial', $2::"SubscriptionStatus", $3::timestamptz, now())`,
      [id, status, readOnlyAt],
    );
    return { id, owner };
  };

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    notifications = new Queue(NOTIFICATIONS_QUEUE, { connection: { url: redis.url } });
    ticks = new QueueEvents(SCHEDULER_QUEUE, { connection: { url: redis.url } });
    await ticks.waitUntilReady();
  });

  afterAll(async () => {
    for (const context of opened) {
      await context.close();
    }
    await notifications?.close();
    await ticks?.close();
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('tells the owners once when the trial ended, and only while APP_URL is set', async () => {
    const { notifications } = started();
    const ended = await organization('TRIALING', '2026-10-01T12:00:00Z');
    await organization('TRIALING', '2999-01-01T00:00:00Z');

    const firstRun = nextRun('tick.read-only');
    const configured = await scheduler('http://localhost:3000/');
    expect(await schedulerKeys()).toContain('tick.read-only');
    await expect(firstRun).resolves.toEqual({ announced: 1, failed: 0 });
    // The next run finds nothing new.
    const handlers = configured.get<TickHandlers>(TICK_HANDLERS);
    await expect(handlers['tick.read-only']?.()).resolves.toEqual({ announced: 0, failed: 0 });

    const jobs = await notifications.getJobs(['waiting']);
    expect(jobs.map((job) => job.id)).toEqual([
      `ntf.read-only.${ended.id}.${String(Date.parse('2026-10-01T12:00:00Z'))}.${ended.owner}`,
    ]);
    expect(await openedEmail(TOKEN_KEYS, jobs[0]?.data)).toEqual({
      to: `olivia-${ended.owner}@nordlicht.test`,
      email: {
        template: 'billing-read-only',
        locale: 'en',
        name: 'Olivia',
        url: `http://localhost:3000/org/${ended.id}/billing`,
        organizationName: 'Nordlicht GmbH',
        reason: 'trial',
      },
    });
    const [row] = await query<{ read_only_notified_at: Date | null }>(
      'SELECT read_only_notified_at FROM subscription WHERE organization_id = $1',
      [ended.id],
    );
    expect(row?.read_only_notified_at).toBeInstanceOf(Date);
    await configured.close();
    opened.splice(opened.indexOf(configured), 1);

    await scheduler();
    expect(await schedulerKeys()).not.toContain('tick.read-only');
  });
});
