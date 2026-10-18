import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createPrismaClient, DEMO_USERS, EXPORT_TABLES, seedDemoData } from '@smp/db';
import { S3Storage, type S3StorageConfig } from '@smp/media';
import { GDPR_QUEUE, GdprProducer, NOTIFICATIONS_QUEUE, parseNotifyDispatch } from '@smp/queue';
import {
  startObjectStorage,
  startRedis,
  startTestDatabase,
  type StartedObjectStorage,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';
import { readZip, type ZipEntry } from './support/read-zip';

// Guide step 8.1, "Fertig, wenn": the export is complete and readable. The role "gdpr" packs the
// demo organization into a ZIP in SeaweedFS: a JSON array per table with as many rows as the
// manifest says, the originals of the media library byte for byte, no sealed token and no
// invitation hash; the owner who asked gets the email; the sweep deletes the archive once it
// expired. The archive is read back with a reader of its own, not with the library that wrote it.

const BUCKET = 'smp-test-gdpr';
const PHOTO_NAME = 'Sommerfest Mädchen.jpg';
const SECRET_HASH = `invitation-hash-${randomUUID()}`;

describe('the export in the role "gdpr"', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let objectStorage: StartedObjectStorage | undefined;
  let worker: INestApplicationContext | undefined;
  let storage: S3Storage | undefined;
  let gdpr: Queue | undefined;
  let notifications: Queue | undefined;
  let events: QueueEvents | undefined;
  let demo: { organizationId: string; workspaceId: string; ownerId: string } | undefined;
  const photo = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256));

  const ready = () => {
    if (!database || !storage || !gdpr || !notifications || !events || !demo) {
      throw new Error('not started');
    }
    return { database, storage, gdpr, notifications, events, demo };
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
  /** Adds a job and waits until the worker finished it; the sweep is gone right after it ends. */
  const run = async (add: () => Promise<void>, jobId: string): Promise<unknown> => {
    const { events: queueEvents } = ready();
    const finished = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${jobId} did not finish`));
      }, 60_000);
      const onCompleted = ({ jobId: id, returnvalue }: { jobId: string; returnvalue: unknown }): void => {
        if (id === jobId) {
          clearTimeout(timer);
          queueEvents.off('completed', onCompleted);
          resolve(typeof returnvalue === 'string' ? (JSON.parse(returnvalue) as unknown) : returnvalue);
        }
      };
      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', ({ jobId: id, failedReason }) => {
        if (id === jobId) {
          clearTimeout(timer);
          reject(new Error(failedReason));
        }
      });
    });
    await add();
    return finished;
  };

  beforeAll(async () => {
    [database, redis, objectStorage] = await Promise.all([
      startTestDatabase(),
      startRedis(),
      startObjectStorage(),
    ]);
    const config: S3StorageConfig = {
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
    const assetId = randomUUID();
    const originalKey = `ws/${workspaceId}/assets/${assetId}/original`;
    await storage.put(originalKey, photo, { contentType: 'image/jpeg' });
    await query(
      `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size, storage_key, updated_at)
       VALUES ($1, $2, 'READY', $3, 'image/jpeg', $4, $5, now()),
              ($6, $2, 'READY', 'gone.png', 'image/png', 10, $7, now())`,
      [
        assetId,
        workspaceId,
        PHOTO_NAME,
        photo.byteLength,
        originalKey,
        randomUUID(),
        `ws/${workspaceId}/assets/gone/original`,
      ],
    );
    const connectionId = randomUUID();
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      access_token_sealed, refresh_token_sealed, updated_at)
       VALUES ($1, $2, 'LINKEDIN', 'API', 'li-1', 'Demo LinkedIn', '\\xdeadbeef'::bytea, '\\xfeedface'::bytea, now())`,
      [connectionId, workspaceId],
    );
    await query(
      `INSERT INTO invitation (id, organization_id, email, role, token_hash, invited_by_id, expires_at)
       VALUES ($1, $2, 'new@demo.test', 'EDITOR', $3, $4, now() + interval '7 days')`,
      [randomUUID(), organizationId, SECRET_HASH, ownerId],
    );

    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'gdpr',
      WORKER_HEALTH_PORT: String(40_000 + Math.floor(Math.random() * 10_000)),
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      DATABASE_SYSTEM_URL: database.url('app_system'),
      APP_URL: 'http://localhost:3000/',
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
    notifications = new Queue(NOTIFICATIONS_QUEUE, { connection: { url: redis.url } });
    events = new QueueEvents(GDPR_QUEUE, { connection: { url: redis.url } });
    await events.waitUntilReady();
  }, 300_000);

  afterAll(async () => {
    await events?.close();
    await gdpr?.close();
    await notifications?.close();
    await worker?.close();
    storage?.destroy();
    await Promise.all([database?.stop(), redis?.stop(), objectStorage?.stop()]);
  });

  let archive: ZipEntry[] = [];
  let requestId = '';

  it('packs the whole organization into a readable ZIP and tells the owner', async () => {
    const { demo: org, storage: store } = ready();
    requestId = randomUUID();
    await query(
      `INSERT INTO gdpr_request (id, organization_id, kind, status, requested_by_id, updated_at)
       VALUES ($1, $2, 'EXPORT', 'PENDING', $3, now())`,
      [requestId, org.organizationId, org.ownerId],
    );

    const result = await run(
      () => new GdprProducer(ready().gdpr).exportData({ requestId }),
      `gdpr.${requestId}`,
    );

    expect(result).toMatchObject({ outcome: 'exported', tables: EXPORT_TABLES.length, mediaFiles: 1 });
    const [request] = await query<{
      status: string;
      object_key: string;
      completed_at: Date;
      expires_at: Date;
    }>(`SELECT status, object_key, completed_at, expires_at FROM gdpr_request WHERE id = $1`, [requestId]);
    expect(request).toMatchObject({
      status: 'COMPLETED',
      object_key: `exports/${org.organizationId}/${requestId}.zip`,
    });
    expect((request?.expires_at.getTime() ?? 0) - (request?.completed_at.getTime() ?? 0)).toBe(
      24 * 60 * 60 * 1000,
    );

    const bytes = await store.get(request?.object_key ?? '', { maxBytes: 50 * 1024 * 1024 });
    archive = readZip(Buffer.from(bytes));
    const names = archive.map((entry) => entry.name);
    expect(names[0]).toBe('README.txt');
    expect(names.at(-1)).toBe('manifest.json');
    expect(names.filter((name) => name.startsWith('data/'))).toEqual(
      EXPORT_TABLES.map((table) => `data/${table.name}.json`),
    );
    const [slug] = (
      await query<{ slug: string }>(`SELECT slug FROM workspace WHERE id = $1`, [org.workspaceId])
    ).map((row) => row.slug);
    const media = archive.filter((entry) => entry.name.startsWith('media/'));
    expect(media.map((entry) => entry.name)).toEqual([
      expect.stringMatching(new RegExp(`^media/${slug ?? ''}/[0-9a-f-]{36}-${PHOTO_NAME}$`)),
    ]);
    // The image is stored as it is, byte for byte; JSON is deflated.
    expect(media[0]?.method).toBe(0);
    expect(media[0]?.data.equals(photo)).toBe(true);
    expect(archive.find((entry) => entry.name === 'data/post.json')?.method).toBe(8);

    const notice = await ready().notifications.getJob(`ntf.export.${requestId}.${org.ownerId}`);
    expect(parseNotifyDispatch(notice?.data)).toMatchObject({
      channel: 'email',
      email: {
        template: 'gdpr-export-ready',
        url: `http://localhost:3000/org/${org.organizationId}/data`,
        organizationName: 'Demo GmbH',
      },
    });
  });

  it('holds as many rows per table as the manifest says, and no secrets', () => {
    const { demo: org } = ready();
    const manifest = JSON.parse(
      archive.find((entry) => entry.name === 'manifest.json')?.data.toString('utf8') ?? '{}',
    ) as {
      organization: { id: string };
      tables: Record<string, number>;
      mediaFiles: number;
      mediaMissing: number;
    };
    expect(manifest).toMatchObject({
      organization: { id: org.organizationId },
      mediaFiles: 1,
      mediaMissing: 1,
    });

    for (const table of EXPORT_TABLES) {
      const rows = JSON.parse(
        archive.find((entry) => entry.name === `data/${table.name}.json`)?.data.toString('utf8') ?? '',
      ) as Record<string, unknown>[];
      expect(rows, table.name).toHaveLength(manifest.tables[table.name] ?? -1);
      for (const row of rows) {
        for (const column of table.omit ?? []) {
          expect(row, `${table.name}.${column}`).not.toHaveProperty(column);
        }
      }
    }
    const json = archive
      .filter((entry) => entry.name.startsWith('data/'))
      .map((entry) => entry.data.toString('utf8'))
      .join('\n');
    expect(json).toContain('Demo LinkedIn');
    expect(json).toContain('new@demo.test');
    for (const secret of [SECRET_HASH, 'deadbeef', 'feedface', 'test-seed-password']) {
      expect(json).not.toContain(secret);
    }
    // Every member, but not their passwords: those live in auth_account, which the export leaves out.
    const users = JSON.parse(
      archive.find((entry) => entry.name === 'data/users.json')?.data.toString('utf8') ?? '[]',
    ) as { email: string }[];
    expect(users.map((user) => user.email).sort()).toEqual(DEMO_USERS.map((user) => user.email).sort());
  });

  it('deletes the archive when the export expired', async () => {
    const { demo: org, storage: store } = ready();
    await query(`UPDATE gdpr_request SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      requestId,
    ]);

    const result = await run(() => new GdprProducer(ready().gdpr).sweep(), 'gdpr.sweep');

    expect(result).toEqual({ exportsExpired: 1, exportsTimedOut: 0 });
    await expect(store.head(`exports/${org.organizationId}/${requestId}.zip`)).resolves.toBeNull();
    const [request] = await query<{ object_key: string | null }>(
      `SELECT object_key FROM gdpr_request WHERE id = $1`,
      [requestId],
    );
    expect(request?.object_key).toBeNull();
  });
});
