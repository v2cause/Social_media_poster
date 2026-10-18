import 'reflect-metadata';

import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createStripeClient } from '@smp/billing';
import { connectionSecretAad, exportPrefixOf, workspacePrefix } from '@smp/core';
import { sealerFromEnv } from '@smp/crypto';
import { createPrismaClient, DEMO_USERS, seedDemoData } from '@smp/db';
import { S3Storage, type S3StorageConfig } from '@smp/media';
import { RedisMockPlatformStore } from '@smp/platform-adapters';
import { GDPR_QUEUE, GdprProducer, gdprJobId, gdprSweepJobId } from '@smp/queue';
import {
  FakeStripe,
  startObjectStorage,
  startRedis,
  startTestDatabase,
  type StartedObjectStorage,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide step 8.2, "Fertig, wenn": no data is left, as the check script shows. The demo
// organization, deleted 30 days ago, is handed on by the sweep of the role "gdpr" and erased: the
// grant of its connection is revoked at the platform, its customer at Stripe is deleted, the
// objects of its workspace and its exports leave the storage, and every row that names it or its
// workspace goes, the webhook events of its customer included. The users stay, without their
// memberships, and the request stays as the record of the erasure, naming nobody. Another
// organization keeps everything. The check script finds the rows before the erasure and nothing
// after it.

const BUCKET = 'smp-test-erasure';
const TOKEN_KEKS = `kek-test:${randomBytes(32).toString('base64')}`;
const ACCESS_TOKEN = `li-access-${randomUUID()}`;
const ROOT = resolve(__dirname, '../../..');

const run = promisify(execFile);

describe('the erasure in the role "gdpr"', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let objectStorage: StartedObjectStorage | undefined;
  let fake: FakeStripe | undefined;
  let worker: INestApplicationContext | undefined;
  let storage: S3Storage | undefined;
  let gdpr: Queue | undefined;
  let events: QueueEvents | undefined;
  let config: S3StorageConfig | undefined;
  let demo: { organizationId: string; workspaceId: string; ownerId: string } | undefined;
  const kept = { organizationId: randomUUID(), workspaceId: randomUUID() };
  const requestId = randomUUID();
  let customerId = '';

  const ready = () => {
    if (!database || !redis || !storage || !gdpr || !events || !fake || !config || !demo) {
      throw new Error('not started');
    }
    return { database, redis, storage, gdpr, events, fake, config, demo };
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
  /** Adds a job and waits for the job with this id to finish; the sweep hands the erasure on. */
  const finished = async (add: () => Promise<void>, jobId: string): Promise<unknown> => {
    const { events: queueEvents } = ready();
    const done = new Promise<unknown>((resolveRun, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${jobId} did not finish`));
      }, 60_000);
      queueEvents.on('completed', ({ jobId: id, returnvalue }) => {
        if (id === jobId) {
          clearTimeout(timer);
          resolveRun(returnvalue);
        }
      });
      queueEvents.on('failed', ({ jobId: id, failedReason }) => {
        if (id === jobId) {
          clearTimeout(timer);
          reject(new Error(failedReason));
        }
      });
    });
    await add();
    return done;
  };
  /** pnpm check:erasure from the root of the repository, against the containers of the test. */
  const checkScript = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
    const storageConfig = ready().config;
    const env = {
      ...process.env,
      DATABASE_SYSTEM_URL: ready().database.url('app_system'),
      S3_ENDPOINT: storageConfig.endpoint,
      S3_REGION: storageConfig.region,
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: storageConfig.accessKeyId,
      S3_SECRET_ACCESS_KEY: storageConfig.secretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
    };
    try {
      const { stdout, stderr } = await run('pnpm', ['--silent', 'check:erasure', requestId], {
        cwd: ROOT,
        env,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  };

  beforeAll(async () => {
    [database, redis, objectStorage, fake] = await Promise.all([
      startTestDatabase(),
      startRedis(),
      startObjectStorage(),
      FakeStripe.start({ webhookSecret: 'whsec_test_erasure' }),
    ]);
    config = {
      endpoint: objectStorage.endpoint,
      region: objectStorage.region,
      bucket: BUCKET,
      accessKeyId: objectStorage.accessKeyId,
      secretAccessKey: objectStorage.secretAccessKey,
      forcePathStyle: true,
    };
    const admin = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    admin.destroy();
    storage = new S3Storage(config);

    const seeder = createPrismaClient(database.url('app_system'));
    try {
      const seeded = await seedDemoData(seeder, 'test-seed-password');
      const ownerEmail = DEMO_USERS.find((user) => user.role === 'OWNER')?.email ?? '';
      const ownerId = seeded.userIds[ownerEmail];
      if (!ownerId) {
        throw new Error('The demo seed has no owner.');
      }
      demo = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, ownerId };
    } finally {
      await seeder.$disconnect();
    }
    const { organizationId, workspaceId, ownerId } = demo;

    // Two connections with sealed tokens: the mock platform revokes the grant of the first; the
    // second was made through the API of X, which this deployment has no adapter for any more.
    const sealer = sealerFromEnv('tokens', { TOKEN_KEKS, TOKEN_KEK_ACTIVE: 'kek-test' });
    for (const [platform, method, accessToken] of [
      ['LINKEDIN', 'MOCK', ACCESS_TOKEN],
      ['X', 'API', `x-access-${randomUUID()}`],
    ] as const) {
      const connectionId = randomUUID();
      const sealed = async (value: string, field: 'access_token' | 'refresh_token'): Promise<Buffer> =>
        Buffer.from(await sealer.seal(value, connectionSecretAad(workspaceId, connectionId, field)));
      await query(
        `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                        access_token_sealed, refresh_token_sealed, updated_at)
         VALUES ($1, $2, $3::"Platform", $4::"ConnectionMethod", $5, 'Demo', $6, $7, now())`,
        [
          connectionId,
          workspaceId,
          platform,
          method,
          `ext-${connectionId}`,
          await sealed(accessToken, 'access_token'),
          await sealed(`refresh-${connectionId}`, 'refresh_token'),
        ],
      );
    }
    // Rows of further tables, among them those without a key to the organization.
    const assetId = randomUUID();
    const postId = randomUUID();
    const variantId = randomUUID();
    for (const [sql, values] of [
      [
        `INSERT INTO media_asset (id, workspace_id, file_name, declared_mime_type, declared_size, storage_key, updated_at)
         VALUES ($1, $2, 'team photo.jpg', 'image/jpeg', 1234, $3, now())`,
        [assetId, workspaceId, `${workspacePrefix(workspaceId)}assets/${assetId}/original`],
      ],
      [
        `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
        [postId, workspaceId],
      ],
      [
        `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
         VALUES ($1, $2, $3, 'X', $4, now())`,
        [variantId, workspaceId, postId, `x:${variantId}`],
      ],
      [
        `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, updated_at)
         VALUES ($1, $2, $3, $4, 0, now())`,
        [randomUUID(), workspaceId, variantId, assetId],
      ],
      [
        `INSERT INTO notification (id, user_id, organization_id, workspace_id, type)
         VALUES ($1, $2, $3, $4, 'publish-failed')`,
        [randomUUID(), ownerId, organizationId, workspaceId],
      ],
      [
        `INSERT INTO feature_flag (id, key, workspace_id, enabled, updated_at)
         VALUES ($1, 'x_browser_enabled', $2, true, now())`,
        [randomUUID(), workspaceId],
      ],
      [
        `INSERT INTO audit_log (id, organization_id, workspace_id, action, target_type)
         VALUES ($1, $2, $3, 'organization.delete_requested', 'Organization')`,
        [randomUUID(), organizationId, workspaceId],
      ],
      [
        `INSERT INTO gdpr_request (id, organization_id, kind, status, requested_by_id, updated_at)
         VALUES ($1, $2, 'EXPORT', 'COMPLETED', $3, now())`,
        [randomUUID(), organizationId, ownerId],
      ],
    ] as const) {
      await query(sql, [...values]);
    }
    // The customer at Stripe, and webhook events that name it or the organization.
    const stripe = createStripeClient({ secretKey: 'sk_test_erasure', apiBase: fake.url });
    customerId = (await stripe.customers.create({ name: 'Demo GmbH', metadata: { organizationId } })).id;
    await query(`UPDATE subscription SET stripe_customer_id = $2 WHERE organization_id = $1`, [
      organizationId,
      customerId,
    ]);
    // Webhook events of Stripe as the API keeps them, with their ids only (ADR 0034): two of the
    // customer of the organization, one of another customer.
    for (const [externalId, ids] of [
      ['evt_subscription', { subscriptionId: 'sub_erasure', customerId }],
      ['evt_invoice', { subscriptionId: null, customerId }],
      ['evt_other', { subscriptionId: 'sub_other', customerId: 'cus_other' }],
    ] as const) {
      await query(
        `INSERT INTO webhook_event (id, provider, external_id, type, payload)
         VALUES ($1, 'stripe', $2, 'customer.subscription.updated', $3::jsonb)`,
        [randomUUID(), externalId, JSON.stringify(ids)],
      );
    }
    // An organization that stays.
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Bleibt GmbH', now())`, [
      kept.organizationId,
    ]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $2, 'bleibt', 'Bleibt', 'Europe/Berlin', 'de', now())`,
      [kept.workspaceId, kept.organizationId],
    );
    // Objects of both organizations in the storage.
    for (const key of [
      `${workspacePrefix(workspaceId)}assets/${randomUUID()}/original`,
      `${workspacePrefix(workspaceId)}assets/${randomUUID()}/thumb_320-full.webp`,
      `${exportPrefixOf(organizationId)}${randomUUID()}.zip`,
      `${workspacePrefix(kept.workspaceId)}assets/${randomUUID()}/original`,
      `${exportPrefixOf(kept.organizationId)}${randomUUID()}.zip`,
    ]) {
      await storage.put(key, new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
    }
    // Deleted by its owner 30 days ago; the erasure is due.
    await query(`UPDATE organization SET deleted_at = now() - interval '30 days' WHERE id = $1`, [
      organizationId,
    ]);
    await query(
      `INSERT INTO gdpr_request (id, organization_id, kind, status, requested_by_id, run_after, details, updated_at)
       VALUES ($1, $2, 'ERASURE', 'PENDING', $3, now() - interval '1 minute', $4::jsonb, now())`,
      [
        requestId,
        organizationId,
        ownerId,
        JSON.stringify({ workspaceIds: [workspaceId], endsSubscription: false }),
      ],
    );

    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'gdpr',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      DATABASE_SYSTEM_URL: database.url('app_system'),
      APP_URL: 'http://localhost:3000/',
      TOKEN_KEKS,
      TOKEN_KEK_ACTIVE: 'kek-test',
      STRIPE_SECRET_KEY: 'sk_test_erasure',
      STRIPE_API_BASE: fake.url,
      S3_ENDPOINT: config.endpoint,
      S3_REGION: config.region,
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: config.accessKeyId,
      S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    });
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoles(['gdpr'], env), {
      logger: false,
    });
    await worker.init();
    gdpr = new Queue(GDPR_QUEUE, { connection: { url: redis.url } });
    events = new QueueEvents(GDPR_QUEUE, { connection: { url: redis.url } });
    await events.waitUntilReady();
  }, 300_000);

  afterAll(async () => {
    await events?.close();
    await gdpr?.close();
    await worker?.close();
    storage?.destroy();
    await fake?.close();
    await Promise.all([database?.stop(), redis?.stop(), objectStorage?.stop()]);
  });

  /** The rows the check script found before the erasure, per table. */
  let rowsBefore: Record<string, number> = {};

  it('finds the rows of the deleted organization before its erasure', async () => {
    const check = await checkScript();

    expect(check.code).toBe(1);
    expect(check.stderr).toContain('The erasure is PENDING, not COMPLETED.');
    expect(check.stderr).toContain('The record still names who asked for the erasure.');
    rowsBefore = Object.fromEntries(
      [...check.stderr.matchAll(/^(\w+): (\d+) rows left$/gm)].map(([, table, count]): [string, number] => [
        table ?? '',
        Number(count),
      ]),
    );
    expect(rowsBefore).toMatchObject({
      organization: 1,
      workspace: 1,
      membership: DEMO_USERS.length,
      social_connection: 2,
      media_asset: 1,
      post: 1,
      post_variant: 1,
      post_media: 1,
      notification: 1,
      feature_flag: 1,
      audit_log: 1,
      // The export; the erasure itself is the record and stays.
      gdpr_request: 1,
      // The events of its customer at Stripe, while the subscription names it.
      webhook_event: 2,
    });
    expect(check.stderr).toContain(`ws/${ready().demo.workspaceId}/: 2 objects left`);
    expect(check.stderr).toContain(`exports/${ready().demo.organizationId}/: 1 objects left`);
  });

  it('erases the organization through the sweep and leaves nothing, as the check script shows', async () => {
    const { demo: org, gdpr: queue, fake: stripe } = ready();

    const result = await finished(() => new GdprProducer(queue).sweep(), gdprJobId(requestId));

    // Every row the check found.
    const rowsDeleted = Object.values(rowsBefore).reduce((sum, count) => sum + count, 0);
    expect(result).toEqual({
      outcome: 'erased',
      tokensRevoked: 1,
      tokensFailed: 1,
      objectsDeleted: 3,
      rowsDeleted,
    });
    const [request] = await query<{ status: string; requested_by_id: string | null; details: unknown }>(
      `SELECT status, requested_by_id, details FROM gdpr_request WHERE id = $1`,
      [requestId],
    );
    expect(request).toMatchObject({
      status: 'COMPLETED',
      requested_by_id: null,
      details: {
        workspaceIds: [org.workspaceId],
        customer: 'deleted',
        tokensRevoked: 1,
        tokensFailed: 1,
        objectsDeleted: 3,
        rowsDeleted,
      },
    });
    // The grant at the platform, the customer at Stripe and the objects are gone.
    const client = new Redis(ready().redis.url);
    try {
      await expect(
        new RedisMockPlatformStore(client).callCount('revoke', ACCESS_TOKEN.slice(0, 12)),
      ).resolves.toBe(1);
    } finally {
      client.disconnect();
    }
    expect(stripe.customers.has(customerId)).toBe(false);
    const [customerEvents] = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM webhook_event WHERE payload ->> 'customerId' = $1`,
      [customerId],
    );
    expect(customerEvents).toEqual({ count: 0 });
    await expect(ready().storage.countPrefix(workspacePrefix(org.workspaceId))).resolves.toBe(0);
    await expect(ready().storage.countPrefix(exportPrefixOf(org.organizationId))).resolves.toBe(0);

    // The check script reads every table with an organization_id or a workspace_id from the catalog.
    const check = await checkScript();
    expect(check.code).toBe(0);
    expect(check.stdout).toContain(
      `Erasure ${requestId}: nothing left of the organization, 2 prefixes checked.`,
    );
  });

  it('keeps the users, the other organization and its objects, and finds nothing more to do', async () => {
    const { demo: org, gdpr: queue } = ready();

    const [users] = await query<{ users: number; memberships: number }>(
      `SELECT (SELECT count(*)::int FROM users WHERE id = $1) AS users,
              (SELECT count(*)::int FROM membership WHERE user_id = $1) AS memberships`,
      [org.ownerId],
    );
    expect(users).toEqual({ users: 1, memberships: 0 });
    const [other] = await query<{ workspaces: number; events: number }>(
      `SELECT (SELECT count(*)::int FROM workspace WHERE organization_id = $1) AS workspaces,
              (SELECT count(*)::int FROM webhook_event WHERE payload ->> 'customerId' = 'cus_other') AS events`,
      [kept.organizationId],
    );
    expect(other).toEqual({ workspaces: 1, events: 1 });
    await expect(ready().storage.countPrefix(workspacePrefix(kept.workspaceId))).resolves.toBe(1);
    await expect(ready().storage.countPrefix(exportPrefixOf(kept.organizationId))).resolves.toBe(1);

    await expect(finished(() => new GdprProducer(queue).sweep(), gdprSweepJobId())).resolves.toEqual({
      exportsExpired: 0,
      exportsTimedOut: 0,
      erasuresQueued: 0,
    });
  });
});
