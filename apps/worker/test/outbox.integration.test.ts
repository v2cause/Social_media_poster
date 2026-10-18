import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sealerFromEnv } from '@smp/crypto';
// eslint-disable-next-line no-restricted-imports -- two relays on their own system clients, wired like src/infrastructure does
import { createSystemPrismaClient } from '@smp/db';
import { PrismaOutboxRelay, type SystemPrismaClient } from '@smp/db';
import {
  LiveEventPublisher,
  NOTIFICATIONS_QUEUE,
  NotificationProducer,
  publishJobId,
  PUBLISH_QUEUE,
  PublishProducer,
  SCHEDULER_QUEUE,
} from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRoles } from '../src/roles';
import { OutboxDispatcher } from '../src/scheduler/outbox-dispatcher';
import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide step 4.3, "Fertig, wenn": an outbox event arrives exactly once as a job, even with two
// relays running at the same time. Then the role "scheduler" relays an event through its tick.

const org = randomUUID();
const workspace = randomUUID();
const EVENTS = 60;
const key = (): string => `kek-test:${randomBytes(32).toString('base64')}`;

describe('outbox relay of the worker', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  const opened: { close: () => Promise<unknown> }[] = [];

  const started = () => {
    if (!database || !redis) {
      throw new Error('not started');
    }
    return { database, redis };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  /** A Redis connection that is closed after its queues, when the tests end. */
  const redisConnection = (): Redis => {
    const client = new Redis(started().redis.url, { maxRetriesPerRequest: null });
    opened.push({
      close: () => {
        client.disconnect();
        return Promise.resolve();
      },
    });
    return client;
  };
  const queueOf = (name: string): Queue => {
    const queue = new Queue(name, { connection: redisConnection() });
    opened.push(queue);
    return queue;
  };
  const publishQueue = (): Queue => queueOf(PUBLISH_QUEUE);
  const insertEvents = (count: number): Promise<{ id: string; variant_id: string }[]> =>
    query(
      `INSERT INTO outbox_event (id, workspace_id, type, payload)
       SELECT gen_random_uuid(), $1, 'publish.requested',
              jsonb_build_object('variantId', v.id, 'scheduleVersion', 1, 'trigger', 'now')
         FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, $2::int)) AS v
       RETURNING id, payload->>'variantId' AS variant_id`,
      [workspace, count],
    );

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'outbox-worker', 'Worker', 'Europe/Berlin', 'de', now())`,
      [workspace, org],
    );
  });

  afterAll(async () => {
    for (const handle of opened.reverse()) {
      await handle.close();
    }
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('adds every event exactly once as a job while two relays run at the same time', async () => {
    const events = await insertEvents(EVENTS);
    const relays = [0, 1].map(() => {
      const system: SystemPrismaClient = createSystemPrismaClient(started().database.url('app_system'));
      opened.push({ close: () => system.$disconnect() });
      return {
        relay: new PrismaOutboxRelay(system, { batchSize: 7 }),
        // The events here are publish requests only; live events have a test of their own.
        dispatcher: new OutboxDispatcher({
          publish: new PublishProducer(publishQueue()),
          live: new LiveEventPublisher(new Redis(started().redis.url, { lazyConnect: true })),
          notifications: new NotificationProducer(
            queueOf(NOTIFICATIONS_QUEUE),
            sealerFromEnv('tokens', { TOKEN_KEKS: key(), TOKEN_KEK_ACTIVE: 'kek-test' }),
          ),
        }),
      };
    });
    const drain = async ({ relay, dispatcher }: (typeof relays)[number]): Promise<number> => {
      let total = 0;
      for (;;) {
        const { relayed } = await relay.relay((event) => dispatcher.dispatch(event));
        total += relayed;
        if (relayed === 0) {
          return total;
        }
      }
    };

    const counts = await Promise.all(relays.map(drain));

    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(EVENTS);
    const queue = publishQueue();
    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(EVENTS);
    expect(new Set(jobs.map((job) => job.id))).toEqual(
      new Set(events.map((event) => publishJobId(event.variant_id, 1))),
    );
    expect(jobs[0]?.data).toMatchObject({ organizationId: org, workspaceId: workspace, trigger: 'now' });

    // A second dispatch of the same event, as after a commit that failed, adds nothing.
    const [again] = await query<{ id: string; payload: unknown; created_at: Date }>(
      'SELECT id, payload, created_at FROM outbox_event WHERE id = $1',
      [events[0]?.id],
    );
    await relays[0]?.dispatcher.dispatch({
      id: again?.id ?? '',
      organizationId: org,
      workspaceId: workspace,
      type: 'publish.requested',
      payload: again?.payload,
      attempts: 0,
      createdAt: again?.created_at ?? new Date(0),
    });
    expect(await queue.getJobCountByTypes('waiting')).toBe(EVENTS);
  });

  it('relays an event through the tick of the role "scheduler"', async () => {
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'scheduler',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: started().redis.url,
      DATABASE_URL: started().database.url('app_user'),
      DATABASE_SYSTEM_URL: started().database.url('app_system'),
      TOKEN_KEKS: key(),
      TOKEN_KEK_ACTIVE: 'kek-test',
      SESSION_KEKS: key(),
      SESSION_KEK_ACTIVE: 'kek-test',
    });
    const worker: INestApplicationContext = await NestFactory.createApplicationContext(
      WorkerModule.forRoles(parseRoles(env.WORKER_ROLES), env),
      { logger: false },
    );
    opened.push(worker);
    const [event] = await insertEvents(1);

    const queue = publishQueue();
    const jobId = publishJobId(event?.variant_id ?? '', 1);
    for (let waited = 0; waited < 15_000 && !(await queue.getJob(jobId)); waited += 250) {
      await sleep(250);
    }

    expect(await queue.getJob(jobId)).toBeDefined();
    const schedulers = await queueOf(SCHEDULER_QUEUE).getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key).sort()).toEqual([
      'tick.account-metrics',
      'tick.analytics',
      'tick.gdpr',
      'tick.maintenance',
      'tick.outbox-relay',
      'tick.publish',
      'tick.sweep-queued',
      'tick.tokens',
    ]);
    const [row] = await query<{ processed: boolean }>(
      'SELECT processed_at IS NOT NULL AS processed FROM outbox_event WHERE id = $1',
      [event?.id],
    );
    expect(row?.processed).toBe(true);
  });
});
