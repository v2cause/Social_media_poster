import { randomUUID } from 'node:crypto';

// eslint-disable-next-line no-restricted-imports -- two scheduler workers on their own system clients, wired like src/infrastructure does
import { createSystemPrismaClient, PrismaPublishScheduler, type SystemPrismaClient } from '@smp/db';
import { publishJobId, PUBLISH_QUEUE, PublishProducer } from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PublishTick } from '../src/scheduler/publish-tick';
import { Sweeper } from '../src/scheduler/sweeper';

// Guide step 4.7, "Fertig, wenn": two workers and 1000 due variants give exactly 1000 jobs. The
// claims run with SKIP LOCKED in the database and the jobs are added after the commit under
// their deterministic id. Then the missed window and the sweeper.

const org = randomUUID();
const failing = randomUUID();
const postingAnyway = randomUUID();
const DUE = 1000;
const BATCH = 100;

describe('scheduler ticks of the worker', () => {
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
  const connection = (): Redis => {
    const client = new Redis(started().redis.url, { maxRetriesPerRequest: null });
    opened.push({
      close: () => {
        client.disconnect();
        return Promise.resolve();
      },
    });
    return client;
  };
  const publishQueue = (): Queue => {
    const queue = new Queue(PUBLISH_QUEUE, { connection: connection() });
    opened.unshift(queue);
    return queue;
  };
  /** One scheduler worker: its own system client, queue connection and producer. */
  const workerParts = () => {
    const system: SystemPrismaClient = createSystemPrismaClient(started().database.url('app_system'));
    opened.unshift({ close: () => system.$disconnect() });
    const plans = new PrismaPublishScheduler(system, { batchSize: BATCH });
    const queue = publishQueue();
    const producer = new PublishProducer(queue);
    return {
      tick: new PublishTick({ plans, producer, now: () => Date.now(), batchSize: BATCH }),
      sweeper: new Sweeper({ plans, queue, producer }),
    };
  };
  /** Variants of a workspace, planned the given minutes from now (negative: overdue). */
  const plan = (workspaceId: string, count: number, minutesFromNow: number) =>
    query<{ id: string }>(
      `WITH post AS (
         INSERT INTO post (id, workspace_id, brief, language, updated_at)
         VALUES (gen_random_uuid(), $1, 'Brief', 'de', now()) RETURNING id
       )
       INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, status,
                                 scheduled_at, scheduled_timezone, schedule_version, updated_at)
       SELECT gen_random_uuid(), $1, post.id, 'LINKEDIN', 't' || n, 'Text ' || n, 'SCHEDULED',
              now() + make_interval(mins => $3::int) - make_interval(secs => n % 50), 'Europe/Berlin', 1, now()
         FROM post, generate_series(1, $2::int) AS n
       RETURNING id`,
      [workspaceId, count, minutesFromNow],
    );

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $3, 'ticks-fail', 'Fail', 'Europe/Berlin', 'de', now()),
              ($2, $3, 'ticks-anyway', 'Anyway', 'Europe/Berlin', 'de', now())`,
      [failing, postingAnyway, org],
    );
    await query(
      `INSERT INTO workspace_settings (workspace_id, missed_window_behavior, updated_at) VALUES ($1, 'POST_ANYWAY', now())`,
      [postingAnyway],
    );
  });

  afterAll(async () => {
    for (const handle of opened) {
      await handle.close();
    }
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('turns 1000 due variants into exactly 1000 jobs with two workers at the same time', async () => {
    const due = [...(await plan(failing, DUE / 2, -30)), ...(await plan(postingAnyway, DUE / 2, -1))];
    const later = await plan(failing, 5, 60);
    const workers = [workerParts(), workerParts()];

    const drain = async ({ tick }: ReturnType<typeof workerParts>): Promise<number> => {
      let total = 0;
      for (;;) {
        const { queued } = (await tick.run()) as { queued: number };
        total += queued;
        if (queued === 0) {
          return total;
        }
      }
    };
    const counts = await Promise.all(workers.map(drain));

    expect(counts[0] ?? 0).toBeGreaterThan(0);
    expect(counts[1] ?? 0).toBeGreaterThan(0);
    expect((counts[0] ?? 0) + (counts[1] ?? 0)).toBe(DUE);
    const queue = publishQueue();
    const jobs = await queue.getJobs(['waiting', 'delayed']);
    expect(jobs).toHaveLength(DUE);
    expect(new Set(jobs.map((job) => job.id))).toEqual(new Set(due.map((row) => publishJobId(row.id, 1))));
    expect(jobs[0]?.data).toMatchObject({ organizationId: org, scheduleVersion: 1, trigger: 'schedule' });

    const statuses = await query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM post_variant GROUP BY status ORDER BY status::text`,
    );
    expect(statuses).toEqual([
      { status: 'QUEUED', count: DUE },
      { status: 'SCHEDULED', count: later.length },
    ]);
    const [events] = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox_event WHERE type = 'variant.status' AND payload->>'status' = 'QUEUED'`,
    );
    expect(events?.count).toBe(DUE);
  });

  it('fails plans overdue beyond six hours, unless the workspace posts them anyway', async () => {
    const missed = await plan(failing, 3, -7 * 60);
    const anyway = await plan(postingAnyway, 2, -7 * 60);

    const result = await workerParts().tick.run();

    expect(result).toEqual({ queued: anyway.length, missed: missed.length, enqueueFailed: 0 });
    const rows = await query<{ id: string; status: string; failure_code: string | null }>(
      `SELECT id, status, failure_code FROM post_variant WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[...missed, ...anyway].map((row) => row.id)],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of missed) {
      expect(byId.get(row.id)).toMatchObject({ status: 'FAILED', failure_code: 'MISSED_WINDOW' });
    }
    for (const row of anyway) {
      expect(byId.get(row.id)).toMatchObject({ status: 'QUEUED', failure_code: null });
    }
    // Guide step 4.9: the author of each missed one hears of it.
    const notices = await query<{ variant_id: string }>(
      `SELECT payload->>'variantId' AS variant_id FROM outbox_event
        WHERE type = 'notification.requested' AND payload->>'type' = 'publish-failed'
          AND payload->>'failureCode' = 'MISSED_WINDOW' AND payload->>'variantId' = ANY($1::text[])`,
      [[...missed, ...anyway].map((row) => row.id)],
    );
    expect(notices.map((row) => row.variant_id).sort()).toEqual(missed.map((row) => row.id).sort());
  });

  it('gives lost jobs back and restarts failed ones, leaving running ones alone', async () => {
    const { tick, sweeper } = workerParts();
    const queue = publishQueue();
    await queue.obliterate({ force: true });

    // A job that fails for good.
    const [failed] = await plan(failing, 1, -1);
    await tick.run();
    const failer = new Worker(PUBLISH_QUEUE, () => Promise.reject(new UnrecoverableError('broken')), {
      connection: connection(),
    });
    opened.unshift({ close: () => failer.close() });
    const failedJob = publishJobId(failed?.id ?? '', 1);
    for (let waited = 0; waited < 10_000; waited += 100) {
      if ((await (await queue.getJob(failedJob))?.getState()) === 'failed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await failer.close();

    // A job that Redis lost, one of a worker that died mid-publish, and one still delayed.
    const [lost, crashed] = await plan(failing, 2, -1);
    const [waiting] = await plan(failing, 1, 0);
    if (!failed || !lost || !crashed || !waiting) {
      throw new Error('fixture missing');
    }
    await query(`UPDATE post_variant SET scheduled_at = now() + interval '20 seconds' WHERE id = $1`, [
      waiting.id,
    ]);
    await tick.run();
    await (await queue.getJob(publishJobId(lost.id, 1)))?.remove();
    await (await queue.getJob(publishJobId(crashed.id, 1)))?.remove();
    await query(
      `UPDATE post_variant SET status = 'PUBLISHING', lease_until = now() - interval '1 minute' WHERE id = $1`,
      [crashed.id],
    );
    await query(
      `UPDATE post_variant SET queued_at = now() - interval '3 minutes' WHERE id = ANY($1::uuid[])`,
      [[failed.id, lost.id, waiting.id]],
    );

    const result = await sweeper.run();

    expect(result).toEqual({ checked: 4, added: 2, restarted: 1, running: 1, failed: 0 });
    for (const variant of [lost, crashed]) {
      const job = await queue.getJob(publishJobId(variant.id, 1));
      expect(job?.data).toMatchObject({ variantId: variant.id, trigger: 'sweep' });
    }
    expect(await (await queue.getJob(failedJob))?.getState()).toBe('waiting');
    expect(await (await queue.getJob(publishJobId(waiting.id, 1)))?.getState()).toBe('delayed');
  });
});
