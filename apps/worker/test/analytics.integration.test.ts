import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { connectionSecretAad } from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import { RedisMockPlatformStore } from '@smp/platform-adapters';
import { ANALYTICS_QUEUE, AnalyticsProducer, PUBLISH_QUEUE, PublishProducer } from '@smp/queue';
import { startRedis, startTestDatabase, type StartedRedis, type TestDatabase } from '@smp/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseRoles } from '../src/roles';
import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide step 5.2 with the mock platform: a post published by the role "publisher" gets its
// first metrics poll after an hour, here a second in time lapse (ANALYTICS_CADENCE_SCALE=3600).
// The role "analytics" polls it, stores the snapshot and plans the next poll; once the post is
// deleted on the platform, the next poll marks it and ends its polls. The daily numbers of the
// account land per day.

const org = randomUUID();
const workspace = randomUUID();
const KEK = `kek-test:${randomBytes(32).toString('base64')}`;
const sealer = sealerFromEnv('tokens', { TOKEN_KEKS: KEK, TOKEN_KEK_ACTIVE: 'kek-test' });
const SCALE = 3_600;

describe('the analytics role', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let commands: Redis | undefined;
  let worker: INestApplicationContext | undefined;
  const queues: Queue[] = [];
  const connections: Redis[] = [];

  const started = () => {
    if (!database || !redis || !commands) {
      throw new Error('not started');
    }
    return { database, redis, commands };
  };
  const connection = (): Redis => {
    const client = new Redis(started().redis.url, { maxRetriesPerRequest: null });
    connections.push(client);
    return client;
  };
  const queue = (name: string): Queue => {
    const created = new Queue(name, { connection: connection() });
    queues.push(created);
    return created;
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const waitFor = async (what: string, condition: () => Promise<boolean>, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await sleep(100);
    }
  };
  const variantOf = async (variantId: string) =>
    (
      await query<{
        status: string;
        external_post_id: string | null;
        published_at: Date | null;
        metrics_step: number;
        metrics_next_at: Date | null;
        external_deleted_at: Date | null;
      }>(
        `SELECT status, external_post_id, published_at, metrics_step, metrics_next_at, external_deleted_at
           FROM post_variant WHERE id = $1`,
        [variantId],
      )
    )[0];

  beforeAll(async () => {
    [database, redis] = await Promise.all([startTestDatabase(), startRedis()]);
    commands = new Redis(redis.url, { maxRetriesPerRequest: null });
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'analytics', 'Analytics', 'Europe/Berlin', 'de', now())`,
      [workspace, org],
    );
    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'publisher,analytics',
      WORKER_HEALTH_PORT: String(40_000 + Math.floor(Math.random() * 10_000)),
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      TOKEN_KEKS: KEK,
      TOKEN_KEK_ACTIVE: 'kek-test',
      // Signing a URL needs no connection; these variants have no media.
      S3_ENDPOINT: 'http://127.0.0.1:9',
      S3_REGION: 'eu-central-1',
      S3_BUCKET: 'media',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test-secret',
      ANALYTICS_CADENCE_SCALE: String(SCALE),
    });
    worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoles(parseRoles(env.WORKER_ROLES), env),
      { logger: false },
    );
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    for (const created of queues) {
      await created.close();
    }
    for (const client of [...connections, commands]) {
      client?.disconnect();
    }
    await Promise.all([database?.stop(), redis?.stop()]);
  });

  it('polls a published post in time lapse, plans the next poll and ends the polls once it is deleted', async () => {
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
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 'PROFILE', $4, 'Mira', now())`,
      [accountId, workspace, connectionId, `urn:li:person:${accountId}`],
    );
    await query(
      `INSERT INTO post (id, workspace_id, brief, language, updated_at) VALUES ($1, $2, 'Brief', 'de', now())`,
      [postId, workspace],
    );
    await query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, text, social_account_id,
                                 status, version, schedule_version, queued_at, updated_at)
       VALUES ($1, $2, $3, 'LINKEDIN', 't1', 'Neue Kennzahlen im Blog.', $4, 'QUEUED', 2, 1, now(), now())`,
      [variantId, workspace, postId, accountId],
    );

    await new PublishProducer(queue(PUBLISH_QUEUE)).publish({
      organizationId: org,
      workspaceId: workspace,
      variantId,
      scheduleVersion: 1,
      trigger: 'now',
    });
    await waitFor('the post', async () => (await variantOf(variantId))?.status === 'PUBLISHED');
    const published = await variantOf(variantId);
    const publishedAt = published?.published_at?.getTime() ?? 0;
    // The first poll an hour after the post, in time lapse a second.
    expect(published?.metrics_next_at).toEqual(new Date(publishedAt + 1_000));

    const analytics = new AnalyticsProducer(queue(ANALYTICS_QUEUE));
    const poll = (bucket: string) =>
      analytics.postMetrics({ organizationId: org, workspaceId: workspace, accountId, bucket });
    await sleep(1_200);
    await poll('first');
    await waitFor('the snapshot', async () => {
      const rows = await query(`SELECT 1 FROM metric_snapshot WHERE variant_id = $1`, [variantId]);
      return rows.length === 1;
    });
    const [snapshot] = await query<{ step: number; impressions: number | null; saves: number | null }>(
      `SELECT step, impressions, saves FROM metric_snapshot WHERE variant_id = $1`,
      [variantId],
    );
    expect(snapshot?.step).toBe(0);
    expect(snapshot?.impressions).toEqual(expect.any(Number));
    // LinkedIn reports no saves: null, not 0.
    expect(snapshot?.saves).toBeNull();
    expect(await query(`SELECT 1 FROM post_metric_latest WHERE variant_id = $1`, [variantId])).toHaveLength(
      1,
    );
    // The poll after 24 hours: 24 seconds after the post in time lapse.
    expect(await variantOf(variantId)).toMatchObject({
      metrics_step: 1,
      metrics_next_at: new Date(publishedAt + 24_000),
    });

    // The post is deleted on the platform; the next poll marks it and ends the polls.
    const store = new RedisMockPlatformStore(started().commands);
    const externalId = published?.external_post_id ?? '';
    const post = await store.find(externalId);
    if (!post) {
      throw new Error('the mock platform does not know the post');
    }
    await store.save({ ...post, deletedAt: new Date() });
    await query(`UPDATE post_variant SET metrics_next_at = now() WHERE id = $1`, [variantId]);
    await poll('second');
    await waitFor('the mark', async () => (await variantOf(variantId))?.external_deleted_at !== null);
    expect(await variantOf(variantId)).toMatchObject({ metrics_next_at: null, metrics_step: 1 });

    await analytics.accountMetrics({
      organizationId: org,
      workspaceId: workspace,
      accountId,
      day: '2026-10-15',
    });
    await waitFor('the daily numbers', async () => {
      const rows = await query(
        `SELECT 1 FROM account_metric_snapshot WHERE social_account_id = $1 AND day = '2026-10-15'`,
        [accountId],
      );
      return rows.length === 1;
    });
  }, 120_000);
});
