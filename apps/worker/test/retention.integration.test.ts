import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MIN_METRICS_DAYS } from '@smp/core';
import { createPrismaClient, seedDemoAnalytics, seedDemoData } from '@smp/db';
import { SCHEDULER_QUEUE } from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TickHandlers } from '../src/processors/scheduler.processor';
import { parseRoles } from '../src/roles';
import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';
import { TICK_HANDLERS } from '../src/worker.tokens';

// Guide step 8.3, "Fertig, wenn": the jobs run at night. The role "scheduler" plans
// tick.maintenance for 03:41 UTC, and the tick applies the retention periods: the raw data of an
// AI generation older than 180 days is cleared, a webhook event processed more than 30 days ago
// is deleted, an entry of the audit log older than 30 days loses its IP address and user agent,
// an account never verified goes after a day (guide step 8.4), and the metrics of an
// organization go beyond the history of its plan, here the 30 days of the trial, which the
// nightly rollup stretches to 36.

const DAY = 24 * 60 * 60 * 1000;

describe('the retention periods in the nightly maintenance of the role "scheduler"', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let worker: INestApplicationContext | undefined;
  let demo: { organizationId: string; workspaceId: string } | undefined;
  const generations = { old: randomUUID(), recent: randomUUID() };
  const entries = { old: randomUUID(), recent: randomUUID() };
  const unverified = { old: randomUUID(), recent: randomUUID() };

  const ready = () => {
    if (!database || !redis || !worker || !demo) {
      throw new Error('not started');
    }
    return { database, redis, worker, demo };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!database) {
      throw new Error('the database is not running');
    }
    const client = await database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);
  const metricsBefore = async (moment: Date): Promise<number> => {
    const [row] = await query<{ count: number }>(
      `SELECT ((SELECT count(*) FROM metric_snapshot WHERE workspace_id = $1 AND captured_at < $2)
             + (SELECT count(*) FROM account_metric_snapshot WHERE workspace_id = $1 AND day < $2::date)
             + (SELECT count(*) FROM analytics_daily WHERE workspace_id = $1 AND day < $2::date))::int AS count`,
      [ready().demo.workspaceId, moment],
    );
    return row?.count ?? -1;
  };

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    const seeder = createPrismaClient(database.url('app_system'));
    try {
      const seeded = await seedDemoData(seeder, 'test-seed-password');
      await seedDemoAnalytics(seeder, seeded, new Date());
      demo = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId };
    } finally {
      await seeder.$disconnect();
    }
    // The demo organization falls back to the trial, whose history is 30 days.
    await query(`UPDATE subscription SET plan_key = 'trial' WHERE organization_id = $1`, [
      demo.organizationId,
    ]);
    for (const [id, createdAt] of [
      [generations.old, daysAgo(181)],
      [generations.recent, daysAgo(179)],
    ] as const) {
      await query(
        `INSERT INTO ai_generation (id, workspace_id, task, prompt_version, provider, model_requested, effort,
                                    input, output, outcome, cost_micros, created_at)
         VALUES ($1, $2, 'GENERATE', 'v1', 'mock', 'mock-model', 'low', '{"brief": "Launch"}',
                 '{"text": "Hello"}', 'OK', 4200, $3)`,
        [id, demo.workspaceId, createdAt],
      );
    }
    for (const [externalId, processedAt] of [
      ['evt_old', daysAgo(31)],
      ['evt_recent', daysAgo(29)],
    ] as const) {
      await query(
        `INSERT INTO webhook_event (id, provider, external_id, type, payload, processed_at)
         VALUES ($1, 'stripe', $2, 'invoice.paid', '{}', $3)`,
        [randomUUID(), externalId, processedAt],
      );
    }

    for (const [id, createdAt] of [
      [entries.old, daysAgo(31)],
      [entries.recent, daysAgo(29)],
    ] as const) {
      await query(
        `INSERT INTO audit_log (id, organization_id, action, target_type, ip_address, user_agent, created_at)
         VALUES ($1, $2, 'post.create', 'post', '203.0.113.7', 'Browser/1.0', $3)`,
        [id, demo.organizationId, createdAt],
      );
    }

    for (const [id, createdAt] of [
      [unverified.old, daysAgo(2)],
      [unverified.recent, new Date()],
    ] as const) {
      await query(
        `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
         VALUES ($1, $2, 'Somebody', false, $3, now())`,
        [id, `${id}@unverified.test`, createdAt],
      );
    }

    const key = (): string => `kek-test:${randomBytes(32).toString('base64')}`;
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'scheduler',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      DATABASE_SYSTEM_URL: database.url('app_system'),
      TOKEN_KEKS: key(),
      TOKEN_KEK_ACTIVE: 'kek-test',
      SESSION_KEKS: key(),
      SESSION_KEK_ACTIVE: 'kek-test',
    });
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoles(parseRoles(env.WORKER_ROLES), env),
      {
        logger: false,
      },
    );
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('plans the maintenance for the night', async () => {
    const queue = new Queue(SCHEDULER_QUEUE, { connection: { url: ready().redis.url } });
    try {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers.find((entry) => entry.key === 'tick.maintenance')).toMatchObject({
        pattern: '41 3 * * *',
        tz: 'UTC',
      });
    } finally {
      await queue.close();
    }
  });

  it('clears old raw data of AI and connection data, deletes old webhook events, old accounts never verified and the metrics beyond the history of the plan', async () => {
    const cutoff = daysAgo(MIN_METRICS_DAYS);
    const before = await metricsBefore(cutoff);
    const kept = (await metricsBefore(new Date())) - before;
    expect(before).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);

    const handlers = ready().worker.get<TickHandlers>(TICK_HANDLERS);
    const result = await handlers['tick.maintenance']?.();

    expect(result).toMatchObject({
      aiRawDataCleared: 1,
      webhooksDeleted: 1,
      connectionDataCleared: 1,
      unverifiedUsersDeleted: 1,
      metricsDeleted: before,
      metricsFailed: 0,
    });
    const rows = await query<{ id: string; input: unknown; output: unknown; cost: string }>(
      `SELECT id, input, output, cost_micros::text AS cost FROM ai_generation WHERE id = ANY($1) ORDER BY created_at`,
      [[generations.old, generations.recent]],
    );
    expect(rows).toEqual([
      { id: generations.old, input: null, output: null, cost: '4200' },
      { id: generations.recent, input: { brief: 'Launch' }, output: { text: 'Hello' }, cost: '4200' },
    ]);
    const events = await query<{ external_id: string }>(
      `SELECT external_id FROM webhook_event ORDER BY external_id`,
    );
    expect(events.map((event) => event.external_id)).toEqual(['evt_recent']);
    const audit = await query<{ id: string; ip: string | null }>(
      `SELECT id, ip_address AS ip FROM audit_log WHERE id = ANY($1) ORDER BY created_at`,
      [[entries.old, entries.recent]],
    );
    expect(audit).toEqual([
      { id: entries.old, ip: null },
      { id: entries.recent, ip: '203.0.113.7' },
    ]);
    const users = await query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1)`, [
      [unverified.old, unverified.recent],
    ]);
    expect(users).toEqual([{ id: unverified.recent }]);
    await expect(metricsBefore(cutoff)).resolves.toBe(0);
    await expect(metricsBefore(new Date())).resolves.toBe(kept);
  });
});
