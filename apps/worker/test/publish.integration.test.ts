import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { connectionSecretAad } from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
// eslint-disable-next-line no-restricted-imports -- the sweeper scans across workspaces on its own system client, wired like src/infrastructure does
import { createSystemPrismaClient, PrismaPublishScheduler, type SystemPrismaClient } from '@smp/db';
import {
  publishDeadLetterId,
  PUBLISH_DEAD_LETTER_QUEUE,
  publishJobId,
  PUBLISH_QUEUE,
  PublishProducer,
} from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PublishWorker } from '../src/publisher/publish-worker';
import { parseRoles } from '../src/roles';
import { Sweeper } from '../src/scheduler/sweeper';
import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide step 4.8, "Fertig, wenn": the worker is stopped in the middle of a publish and started
// again, and there is no second post (the mock platform counts the calls). A second test lets the
// job fail for good while its variant stays PUBLISHING; the sweeper brings it back. Before that,
// the role "publisher" publishes, waits out a rate limit and fails a refused post.

const org = randomUUID();
const workspace = randomUUID();
const KEK = `kek-test:${randomBytes(32).toString('base64')}`;
const sealer = sealerFromEnv('tokens', { TOKEN_KEKS: KEK, TOKEN_KEK_ACTIVE: 'kek-test' });

interface Seeded {
  variantId: string;
  accountId: string;
}

describe('the publisher role', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let commands: Redis | undefined;
  let system: SystemPrismaClient | undefined;
  let queue: Queue | undefined;
  let deadLetters: Queue | undefined;
  /** Connections handed to BullMQ, which leaves them open. */
  const connections: Redis[] = [];
  const connection = (): Redis => {
    if (!redis) {
      throw new Error('Redis not started');
    }
    const client = new Redis(redis.url, { maxRetriesPerRequest: null });
    connections.push(client);
    return client;
  };

  const started = () => {
    if (!database || !redis || !commands || !system || !queue) {
      throw new Error('not started');
    }
    return { database, redis, commands, system, queue };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  /** How often the mock platform saw an operation for an account. */
  const calls = async (operation: string, accountId: string): Promise<number> =>
    Number((await started().commands.hget('mock:calls', `${operation}:${accountId}`)) ?? 0);
  const waitFor = async (
    what: string,
    condition: () => Promise<boolean>,
    timeoutMs = 30_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(100);
    }
  };
  const statusOf = async (variantId: string): Promise<string | undefined> =>
    (await query<{ status: string }>('SELECT status FROM post_variant WHERE id = $1', [variantId]))[0]
      ?.status;
  const attemptsOf = (variantId: string) =>
    query<{ attempt_number: number; outcome: string; error_code: string | null }>(
      `SELECT attempt_number, outcome, error_code FROM publish_attempt
        WHERE variant_id = $1 ORDER BY attempt_number`,
      [variantId],
    );

  /** A queued LinkedIn variant on a mock account of its own, with the fail mode in its settings. */
  const seed = async (settings: Record<string, unknown> = {}): Promise<Seeded> => {
    const connectionId = randomUUID();
    const accountId = randomUUID();
    const postId = randomUUID();
    const variantId = randomUUID();
    const token = await sealer.seal(
      'mock-access',
      connectionSecretAad(workspace, connectionId, 'access_token'),
    );
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      access_token_sealed, access_token_expires_at, updated_at)
       VALUES ($1, $2, 'LINKEDIN', 'MOCK', $3, 'Mira', $4, now() + interval '30 days', now())`,
      [connectionId, workspace, `mock-user-${connectionId}`, Buffer.from(token)],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, settings,
                                   updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 'PROFILE', $4, 'Mira', $5, now())`,
      [accountId, workspace, connectionId, `urn:li:person:${accountId}`, JSON.stringify(settings)],
    );
    await query(
      `INSERT INTO post (id, workspace_id, brief, language, updated_at) VALUES ($1, $2, 'Brief', 'de', now())`,
      [postId, workspace],
    );
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, social_account_id,
                                 status, version, schedule_version, queued_at, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 't1', $4, $5, 'QUEUED', 2, 1, now(), now())`,
      [variantId, workspace, postId, `Wir suchen Verstärkung ${variantId}.`, accountId],
    );
    return { variantId, accountId };
  };
  const enqueue = ({ variantId }: Seeded) =>
    new PublishProducer(started().queue).publish({
      organizationId: org,
      workspaceId: workspace,
      variantId,
      scheduleVersion: 1,
      trigger: 'now',
    });
  /** The copy of a job that failed for good, once the worker made it. */
  const deadLetterOf = async ({ variantId }: Seeded): Promise<unknown> => {
    if (!deadLetters) {
      throw new Error('not started');
    }
    const letters = deadLetters;
    const id = publishDeadLetterId(variantId, 1);
    await waitFor('the dead letter', async () => (await letters.getJob(id)) !== undefined);
    return (await letters.getJob(id))?.data;
  };
  const jobOf = async ({ variantId }: Seeded) => {
    const job = await started().queue.getJob(publishJobId(variantId, 1));
    if (!job) {
      throw new Error('no job');
    }
    return job;
  };

  /** A worker process with the role "publisher": a lock of a second, a lease of three. */
  const startPublisher = (): Promise<INestApplicationContext> => {
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'publisher',
      WORKER_HEALTH_PORT: String(40_000 + Math.floor(Math.random() * 10_000)),
      REDIS_URL: started().redis.url,
      DATABASE_URL: started().database.url('app_user'),
      TOKEN_KEKS: KEK,
      TOKEN_KEK_ACTIVE: 'kek-test',
      // Signing a URL needs no connection; these variants have no media.
      S3_ENDPOINT: 'http://127.0.0.1:9',
      S3_REGION: 'eu-central-1',
      S3_BUCKET: 'media',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test-secret',
      PUBLISH_LOCK_MS: '1000',
      PUBLISH_LEASE_MS: '3000',
    });
    return NestFactory.createApplicationContext(WorkerModule.forRoles(parseRoles(env.WORKER_ROLES), env), {
      logger: false,
    });
  };
  /** Stops a worker in the middle of the publish of a slow post, once the post is out. */
  const killWhenPosted = async (worker: INestApplicationContext, { accountId }: Seeded): Promise<void> => {
    await waitFor('the post', async () => (await calls('created', accountId)) === 1);
    await worker.get(PublishWorker).kill();
    await worker.close();
  };

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    commands = new Redis(redis.url, { maxRetriesPerRequest: null });
    system = createSystemPrismaClient(database.url('app_system'));
    queue = new Queue(PUBLISH_QUEUE, { connection: connection() });
    deadLetters = new Queue(PUBLISH_DEAD_LETTER_QUEUE, { connection: connection() });
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'publisher', 'Publisher', 'Europe/Berlin', 'de', now())`,
      [workspace, org],
    );
  });

  afterAll(async () => {
    await queue?.close();
    await deadLetters?.close();
    for (const client of [...connections, commands]) {
      client?.disconnect();
    }
    await system?.$disconnect();
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('publishes, waits out a rate limit without an attempt and fails a refused post for good', async () => {
    const plain = await seed();
    const limited = await seed({ failMode: 'rate_limit_once', retryAfterSeconds: 1 });
    const refused = await seed({ failMode: 'permanent' });
    const worker = await startPublisher();
    try {
      for (const variant of [plain, limited, refused]) {
        await enqueue(variant);
      }
      await waitFor('the final statuses', async () => {
        const statuses = await Promise.all(
          [plain, limited, refused].map((variant) => statusOf(variant.variantId)),
        );
        return statuses.join() === 'PUBLISHED,PUBLISHED,FAILED';
      });

      expect(await attemptsOf(plain.variantId)).toEqual([
        { attempt_number: 1, outcome: 'PUBLISHED', error_code: null },
      ]);
      expect(await attemptsOf(limited.variantId)).toEqual([
        { attempt_number: 1, outcome: 'RETRY', error_code: 'RATE_LIMITED' },
        { attempt_number: 2, outcome: 'PUBLISHED', error_code: null },
      ]);
      await waitFor('the jobs to settle', async () =>
        ['completed', 'failed'].includes(await (await jobOf(refused)).getState()),
      );
      // The wait for the rate limit used up no attempt: only the run that published counts.
      const limitedJob = await jobOf(limited);
      expect(await limitedJob.getState()).toBe('completed');
      expect(limitedJob.attemptsMade).toBe(1);
      const refusedJob = await jobOf(refused);
      expect(await refusedJob.getState()).toBe('failed');
      expect(refusedJob).toMatchObject({ failedReason: 'VALIDATION_REJECTED', attemptsMade: 1 });
      expect(await query('SELECT failure_code FROM post_variant WHERE id = $1', [refused.variantId])).toEqual(
        [{ failure_code: 'VALIDATION_REJECTED' }],
      );
      // Architecture 7.1: a copy goes to the dead-letter queue.
      expect(await deadLetterOf(refused)).toMatchObject({
        variantId: refused.variantId,
        scheduleVersion: 1,
        failedReason: 'VALIDATION_REJECTED',
        attemptsMade: 1,
      });
    } finally {
      await worker.close();
    }
  });

  it('posts once when the worker is stopped in the middle of the publish and started again', async () => {
    const slow = await seed({ failMode: 'slow' });
    await enqueue(slow);
    await killWhenPosted(await startPublisher(), slow);
    expect(await statusOf(slow.variantId)).toBe('PUBLISHING');

    // The restarted worker takes the stalled job over, waits for the lease and reconciles.
    const restarted = await startPublisher();
    try {
      await waitFor('the reconcile', async () => (await statusOf(slow.variantId)) === 'PUBLISHED');
    } finally {
      await restarted.close();
    }

    expect(await calls('created', slow.accountId)).toBe(1);
    expect(await calls('publish', slow.accountId)).toBe(1);
    expect(await calls('reconcile', slow.accountId)).toBe(1);
    expect(await attemptsOf(slow.variantId)).toEqual([
      { attempt_number: 1, outcome: 'UNKNOWN', error_code: null },
      { attempt_number: 2, outcome: 'RECONCILED', error_code: null },
    ]);
    const [variant] = await query<{ external_post_id: string }>(
      'SELECT external_post_id FROM post_variant WHERE id = $1',
      [slow.variantId],
    );
    expect(variant?.external_post_id).toMatch(/^mock-linkedin-[0-9a-f]{16}$/);
  });

  it('brings a variant back from PUBLISHING with the sweeper after its job failed for good', async () => {
    const slow = await seed({ failMode: 'slow' });
    await enqueue(slow);
    await killWhenPosted(await startPublisher(), slow);

    // A stall check that allows no stall marks the stopped job, and the next worker that takes it
    // fails it for good without running it.
    const checker = new Worker(PUBLISH_QUEUE, null, {
      connection: connection(),
      autorun: false,
      maxStalledCount: 0,
      stalledInterval: 300,
    });
    try {
      await checker.startStalledCheckTimer();
      await waitFor('the stalled job', async () => (await (await jobOf(slow)).getState()) === 'waiting');
    } finally {
      await checker.close();
    }

    const restarted = await startPublisher();
    try {
      await waitFor('the failed job', async () => (await (await jobOf(slow)).getState()) === 'failed');
      expect((await jobOf(slow)).failedReason).toBe('job stalled more than allowable limit');
      expect(await deadLetterOf(slow)).toMatchObject({
        failedReason: 'job stalled more than allowable limit',
      });
      expect(await statusOf(slow.variantId)).toBe('PUBLISHING');

      await waitFor('the end of the lease', async () => {
        const [row] = await query<{ expired: boolean }>(
          'SELECT lease_until < now() AS expired FROM post_variant WHERE id = $1',
          [slow.variantId],
        );
        return row?.expired === true;
      });
      const sweeper = new Sweeper({
        plans: new PrismaPublishScheduler(started().system),
        queue: started().queue,
        producer: new PublishProducer(started().queue),
      });
      await expect(sweeper.run()).resolves.toMatchObject({ restarted: 1 });
      await waitFor('the reconcile', async () => (await statusOf(slow.variantId)) === 'PUBLISHED');
    } finally {
      await restarted.close();
    }

    expect(await calls('created', slow.accountId)).toBe(1);
    expect(await calls('publish', slow.accountId)).toBe(1);
    expect((await attemptsOf(slow.variantId)).map((attempt) => attempt.outcome)).toEqual([
      'UNKNOWN',
      'RECONCILED',
    ]);
  });
});
