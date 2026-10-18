import 'reflect-metadata';

import { randomBytes, randomUUID } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { assetPrefix } from '@smp/core';
import { createPrismaClient, seedDemoData } from '@smp/db';
import { S3Storage, type S3StorageConfig } from '@smp/media';
import { GDPR_QUEUE, GdprProducer, gdprSweepJobId } from '@smp/queue';
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

// Guide steps 8.3 and 8.4 with architecture 9: the hourly sweep of the role "gdpr" cleans up the
// media library in SeaweedFS and PostgreSQL. An asset removed from the library, also one removed
// minutes ago, and an upload still pending after 24 hours lose their objects and their rows; a
// fresh upload and an asset of the library keep theirs.

const BUCKET = 'smp-test-media-cleanup';
const DAY = 24 * 60 * 60 * 1000;

describe('the clean-up of the media library in the sweep of the role "gdpr"', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let objectStorage: StartedObjectStorage | undefined;
  let worker: INestApplicationContext | undefined;
  let storage: S3Storage | undefined;
  let gdpr: Queue | undefined;
  let events: QueueEvents | undefined;
  let workspaceId = '';
  const assets = {
    removedOld: randomUUID(),
    removedRecently: randomUUID(),
    pendingOld: randomUUID(),
    pendingRecent: randomUUID(),
    library: randomUUID(),
  };

  const ready = () => {
    if (!database || !storage || !gdpr || !events) {
      throw new Error('not started');
    }
    return { database, storage, gdpr, events };
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
  const ago = (days: number): Date => new Date(Date.now() - days * DAY);
  /** Runs the sweep and waits for its result; the job is gone right after it ends. */
  const sweep = async (): Promise<unknown> => {
    const { events: queueEvents } = ready();
    const jobId = gdprSweepJobId();
    const finished = new Promise<unknown>((resolve, reject) => {
      const stop = (): void => {
        clearTimeout(timer);
        queueEvents.off('completed', onCompleted);
        queueEvents.off('failed', onFailed);
      };
      const onCompleted = ({ jobId: id, returnvalue }: { jobId: string; returnvalue: unknown }): void => {
        if (id === jobId) {
          stop();
          resolve(typeof returnvalue === 'string' ? (JSON.parse(returnvalue) as unknown) : returnvalue);
        }
      };
      const onFailed = ({ jobId: id, failedReason }: { jobId: string; failedReason: string }): void => {
        if (id === jobId) {
          stop();
          reject(new Error(failedReason));
        }
      };
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`${jobId} did not finish`));
      }, 60_000);
      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', onFailed);
    });
    await new GdprProducer(ready().gdpr).sweep();
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
      ({ workspaceId } = await seedDemoData(seeder, 'test-seed-password'));
    } finally {
      await seeder.$disconnect();
    }
    for (const [id, status, createdAt, deletedAt] of [
      [assets.removedOld, 'READY', ago(90), ago(31)],
      [assets.removedRecently, 'READY', ago(90), ago(0.01)],
      [assets.pendingOld, 'PENDING_UPLOAD', ago(1.1), null],
      [assets.pendingRecent, 'PENDING_UPLOAD', ago(0.5), null],
      [assets.library, 'READY', ago(400), null],
    ] as const) {
      const original = `${assetPrefix(workspaceId, id)}original`;
      await query(
        `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size, storage_key,
                                  created_at, deleted_at, updated_at)
         VALUES ($1, $2, $3, 'photo.jpg', 'image/jpeg', 4, $4, $5, $6, now())`,
        [id, workspaceId, status, original, createdAt, deletedAt],
      );
      await storage.put(original, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { contentType: 'image/jpeg' });
      if (status === 'READY') {
        await storage.put(
          `${assetPrefix(workspaceId, id)}renditions/thumb_320-full.webp`,
          new Uint8Array([1, 2, 3]),
          { contentType: 'image/webp' },
        );
      }
    }

    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ROLES: 'gdpr',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      DATABASE_SYSTEM_URL: database.url('app_system'),
      APP_URL: 'http://localhost:3000/',
      TOKEN_KEKS: `kek-test:${randomBytes(32).toString('base64')}`,
      TOKEN_KEK_ACTIVE: 'kek-test',
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
    await Promise.all([database?.stop(), redis?.stop(), objectStorage?.stop()]);
  });

  it('deletes the objects and rows of expired assets and keeps the others', async () => {
    await expect(sweep()).resolves.toMatchObject({ mediaDeleted: 3, mediaObjectsDeleted: 5 });

    const rows = await query<{ id: string }>(`SELECT id FROM media_asset WHERE id = ANY($1)`, [
      Object.values(assets),
    ]);
    expect(rows.map((row) => row.id).sort()).toEqual([assets.pendingRecent, assets.library].sort());
    const objects = Object.fromEntries(
      await Promise.all(
        Object.entries(assets).map(
          async ([name, id]) =>
            [name, await ready().storage.head(`${assetPrefix(workspaceId, id)}original`)] as const,
        ),
      ),
    );
    expect(objects).toMatchObject({
      removedOld: null,
      removedRecently: null,
      pendingOld: null,
      pendingRecent: { size: 4 },
      library: { size: 4 },
    });

    // The next sweep finds nothing more.
    await expect(sweep()).resolves.toMatchObject({ mediaDeleted: 0, mediaObjectsDeleted: 0 });
  });
});
