import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { CreateBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  CompleteUpload,
  RequestUpload,
  SetVariantMedia,
  systemClock,
  uuidV7Ids,
  type ContentActor,
  type MediaAsset,
  type MediaDependencies,
} from '@smp/core';
import { createPrismaClient, PrismaMediaUnitOfWork, type PrismaClient } from '@smp/db';
import { S3Storage, type S3StorageConfig } from '@smp/media';
import { MEDIA_PROCESS, MEDIA_QUEUE, MediaProducer, mediaDropUploadJobId } from '@smp/queue';
import {
  startObjectStorage,
  startRedis,
  startTestDatabase,
  type StartedObjectStorage,
  type StartedRedis,
  type TestDatabase,
} from '@smp/testing';
import { Queue, QueueEvents } from 'bullmq';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '../src/worker-env';
import { WorkerModule } from '../src/worker.module';

// Guide step 3.3, "Fertig, wenn": a 10 MB JPEG is READY in under 5 s, and a file that is no image
// but is called .jpg ends up REJECTED. The worker role "media" runs against PostgreSQL with
// row-level security, Redis and SeaweedFS; the upload side runs as the API does it. Guide step
// 8.4: the job of the ticket deletes an upload object that a late PUT created again.

const BUCKET = 'smp-test-media';
const MB = 1024 * 1024;
const organizationId = randomUUID();
const workspaceId = randomUUID();
const actor: ContentActor = { userId: randomUUID(), organizationId, workspaceId, role: 'EDITOR' };

describe('media worker', () => {
  let database: TestDatabase | undefined;
  let redis: StartedRedis | undefined;
  let objectStorage: StartedObjectStorage | undefined;
  let worker: INestApplicationContext | undefined;
  let base: PrismaClient | undefined;
  let storage: S3Storage | undefined;
  let queue: Queue | undefined;
  let events: QueueEvents | undefined;

  const ready = () => {
    if (!base || !storage || !queue || !events || !objectStorage) {
      throw new Error('not started');
    }
    return { base, storage, queue, events, objectStorage };
  };

  /** The API side of the media use cases. */
  const apiDeps = (): Omit<MediaDependencies, 'processor'> => {
    const started = ready();
    return {
      unitOfWork: new PrismaMediaUnitOfWork(started.base),
      storage: started.storage,
      jobs: new MediaProducer(started.queue),
      limits: { storageBytes: () => Promise.resolve(100 * MB), storageUsed: () => Promise.resolve(0) },
      clock: systemClock,
      ids: uuidV7Ids,
    };
  };

  /** A ticket and the presigned PUT of the file, as the browser sends it. */
  const requestAndUpload = async (bytes: Uint8Array, fileName: string) => {
    const ticket = await new RequestUpload(apiDeps()).execute({
      actor,
      fileName,
      mimeType: 'image/jpeg',
      size: bytes.byteLength,
    });
    const put = () =>
      fetch(ticket.upload.url, {
        method: ticket.upload.method,
        headers: ticket.upload.headers,
        body: new Uint8Array(bytes),
      });
    expect((await put()).status).toBe(200);
    return { ticket, put };
  };

  /** The upload side as the API runs it: ticket, presigned PUT, completion. */
  const uploadAndComplete = async (bytes: Uint8Array, fileName: string): Promise<MediaAsset> => {
    const { ticket } = await requestAndUpload(bytes, fileName);
    return new CompleteUpload(apiDeps()).execute({ actor, assetId: ticket.asset.id });
  };

  /** Polls the asset until the worker moved it on from PROCESSING. */
  const settled = async (assetId: string, timeoutMs: number): Promise<MediaAsset | null> => {
    const unitOfWork = new PrismaMediaUnitOfWork(ready().base);
    const scope = { userId: null, organizationId, workspaceId };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const asset = await unitOfWork.run(scope, (store) => store.assets.find(workspaceId, assetId));
      if (asset?.status !== 'PROCESSING' || Date.now() > deadline) {
        return asset;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const keysOf = async (prefix: string): Promise<string[]> => {
    const { objectStorage: server } = ready();
    const client = new S3Client({
      endpoint: server.endpoint,
      region: server.region,
      forcePathStyle: true,
      credentials: { accessKeyId: server.accessKeyId, secretAccessKey: server.secretAccessKey },
    });
    try {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
      return (listed.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
    } finally {
      client.destroy();
    }
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

    const system = await database.connectAs('app_system');
    try {
      await system.query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Media', now())`, [
        organizationId,
      ]);
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'media-worker', 'Media', 'Europe/Berlin', 'de', now())`,
        [workspaceId, organizationId],
      );
    } finally {
      await system.end();
    }

    const env = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      WORKER_ROLES: 'media',
      WORKER_HEALTH_PORT: '0',
      REDIS_URL: redis.url,
      DATABASE_URL: database.url('app_user'),
      S3_ENDPOINT: config.endpoint,
      S3_REGION: config.region,
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: config.accessKeyId,
      S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    });
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoles(['media'], env), {
      logger: false,
    });
    await worker.init();

    base = createPrismaClient(database.url('app_user'));
    storage = new S3Storage(config);
    queue = new Queue(MEDIA_QUEUE, { connection: { url: redis.url } });
    events = new QueueEvents(MEDIA_QUEUE, { connection: { url: redis.url } });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events?.close();
    await queue?.close();
    await worker?.close();
    storage?.destroy();
    await base?.$disconnect();
    await Promise.all([database?.stop(), redis?.stop(), objectStorage?.stop()]);
  });

  /** Gaussian noise, the worst case for JPEG: 4000 x 3000 pixels make more than 10 MB. */
  const noisyPhoto = (): Promise<Buffer> =>
    sharp({
      create: {
        width: 4000,
        height: 3000,
        channels: 3,
        background: '#777777',
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

  it('makes a 10 MB JPEG ready in under 5 seconds', async () => {
    const photo = await noisyPhoto();
    expect(photo.byteLength).toBeGreaterThanOrEqual(10 * MB);
    expect(photo.byteLength).toBeLessThanOrEqual(20 * MB);

    const processing = await uploadAndComplete(photo, 'Sommerfest.jpg');
    const startedAt = Date.now();
    const asset = await settled(processing.id, 10_000);
    const elapsed = Date.now() - startedAt;

    expect(processing.status).toBe('PROCESSING');
    expect(asset).toMatchObject({
      status: 'READY',
      mimeType: 'image/jpeg',
      sizeBytes: photo.byteLength,
      width: 4000,
      height: 3000,
    });
    expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(elapsed).toBeLessThan(5_000);
    const prefix = `ws/${workspaceId}/assets/${processing.id}/`;
    expect((await keysOf(prefix)).sort()).toEqual([
      `${prefix}original`,
      `${prefix}renditions/thumb_320-full.webp`,
      `${prefix}renditions/thumb_640-full.webp`,
    ]);
  });

  it('rejects a file called .jpg that is no image and deletes it', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

    const processing = await uploadAndComplete(pdf, 'Rechnung.jpg');
    const asset = await settled(processing.id, 10_000);

    expect(asset).toMatchObject({ status: 'REJECTED', rejectReason: 'NOT_AN_IMAGE', width: null });
    expect(await keysOf(`ws/${workspaceId}/assets/${processing.id}/`)).toEqual([]);
    const client = new S3Client({
      endpoint: ready().objectStorage.endpoint,
      region: ready().objectStorage.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: ready().objectStorage.accessKeyId,
        secretAccessKey: ready().objectStorage.secretAccessKey,
      },
    });
    await expect(
      client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: processing.storageKey })),
    ).rejects.toThrow();
    client.destroy();
  });

  it('deletes an upload object a late PUT created again once the job of the ticket runs', async () => {
    const { queue: media, events: queueEvents } = ready();
    const photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();
    const { ticket, put } = await requestAndUpload(photo, 'Spät.jpg');
    await new CompleteUpload(apiDeps()).execute({ actor, assetId: ticket.asset.id });
    expect(await settled(ticket.asset.id, 10_000)).toMatchObject({ status: 'READY' });
    const prefix = `ws/${workspaceId}/assets/${ticket.asset.id}/`;

    // The link still works for a few minutes after the pipeline took the file.
    expect((await put()).status).toBe(200);
    expect(await keysOf(prefix)).toContain(`${prefix}upload`);
    const drop = await media.getJob(mediaDropUploadJobId(ticket.asset.id));
    expect(await drop?.getState()).toBe('delayed');
    expect(drop?.opts.delay).toBe(65 * 60 * 1000);
    await drop?.promote();

    await expect(drop?.waitUntilFinished(queueEvents)).resolves.toBe('DROPPED');
    expect((await keysOf(prefix)).sort()).toEqual([
      `${prefix}original`,
      `${prefix}renditions/thumb_320-full.webp`,
      `${prefix}renditions/thumb_640-full.webp`,
    ]);

    // An upload that waits for its completion keeps its file.
    const waiting = await requestAndUpload(photo, 'Wartet.jpg');
    const kept = await media.getJob(mediaDropUploadJobId(waiting.ticket.asset.id));
    await kept?.promote();
    await expect(kept?.waitUntilFinished(queueEvents)).resolves.toBe('KEPT');
    expect(await keysOf(`ws/${workspaceId}/assets/${waiting.ticket.asset.id}/`)).toEqual([
      `ws/${workspaceId}/assets/${waiting.ticket.asset.id}/upload`,
    ]);
  });

  it('fails an invalid payload at once instead of retrying it', async () => {
    const { queue: media, events: queueEvents } = ready();
    const job = await media.add(MEDIA_PROCESS, { assetId: '../../etc' }, { attempts: 5 });

    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow(/invalid media.process payload/);
    expect((await media.getJob(job.id ?? ''))?.attemptsMade).toBe(1);
  });

  it('renders an attached image for X within its 5 MB', async () => {
    const processing = await uploadAndComplete(await noisyPhoto(), 'Rauschen.jpg');
    expect(await settled(processing.id, 10_000)).toMatchObject({ status: 'READY' });
    const postId = randomUUID();
    const variantId = randomUUID();
    const system = await database?.connectAs('app_system');
    try {
      await system?.query(
        `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
        [postId, workspaceId],
      );
      await system?.query(
        `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
         VALUES ($1, $2, $3, 'X', 't1', now())`,
        [variantId, workspaceId, postId],
      );
    } finally {
      await system?.end();
    }

    await new SetVariantMedia(apiDeps()).execute({
      actor,
      variantId,
      version: 0,
      items: [{ assetId: processing.id, crop: null, letterbox: false, altText: null }],
    });

    const unitOfWork = new PrismaMediaUnitOfWork(ready().base);
    const scope = { userId: null, organizationId, workspaceId };
    const deadline = Date.now() + 30_000;
    let rendition = null;
    while (!rendition && Date.now() < deadline) {
      rendition = await unitOfWork.run(scope, (store) =>
        store.renditions.find(workspaceId, processing.id, 'x_image', 'full'),
      );
      if (!rendition) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    expect(rendition).toMatchObject({ mimeType: 'image/jpeg' });
    expect(rendition?.sizeBytes).toBeLessThanOrEqual(5 * MB);
    const stored = await ready().storage.head(rendition?.storageKey ?? '');
    expect(stored).toEqual({ size: rendition?.sizeBytes, contentType: 'image/jpeg' });
    const metadata = await sharp(
      await ready().storage.get(rendition?.storageKey ?? '', { maxBytes: 5 * MB }),
    ).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: rendition?.width, height: rendition?.height });
    expect(metadata.exif).toBeUndefined();
  });
});
