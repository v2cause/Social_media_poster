import { randomUUID } from 'node:crypto';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { assetPrefix, originalKey, renditionKey } from '@smp/core';
import { startObjectStorage, type StartedObjectStorage } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { S3Storage, StorageObjectTooLargeError, type S3StorageConfig } from '../src';

// Guide step 3.2, "Fertig, wenn": upload, head, signed GET and delete against SeaweedFS.

const BUCKET = 'smp-test-media';
const workspaceId = randomUUID();

const jpegLike = (size: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: size }, (_, index) =>
    index < 3 ? ([0xff, 0xd8, 0xff][index] ?? 0) : index % 251,
  );

describe('S3 storage against SeaweedFS', () => {
  let server: StartedObjectStorage | undefined;
  let storage: S3Storage | undefined;

  const config = (): S3StorageConfig => {
    if (!server) {
      throw new Error('the object storage is not running');
    }
    return {
      endpoint: server.endpoint,
      region: server.region,
      bucket: BUCKET,
      accessKeyId: server.accessKeyId,
      secretAccessKey: server.secretAccessKey,
      forcePathStyle: true,
    };
  };
  const store = (): S3Storage => {
    if (!storage) {
      throw new Error('the storage adapter is not ready');
    }
    return storage;
  };

  beforeAll(async () => {
    server = await startObjectStorage();
    const admin = new S3Client({
      endpoint: server.endpoint,
      region: server.region,
      forcePathStyle: true,
      credentials: { accessKeyId: server.accessKeyId, secretAccessKey: server.secretAccessKey },
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    admin.destroy();
    storage = new S3Storage(config());
  }, 180_000);

  afterAll(async () => {
    storage?.destroy();
    await server?.stop();
  });

  it('uploads through a presigned PUT and reports size and type', async () => {
    const key = originalKey(workspaceId, randomUUID());
    const body = jpegLike(2048);
    const upload = await store().presignPut(key, { contentType: 'image/jpeg', expiresInSeconds: 300 });

    const response = await fetch(upload.url, { method: upload.method, headers: upload.headers, body });

    expect(response.ok).toBe(true);
    await expect(store().head(key)).resolves.toEqual({ size: 2048, contentType: 'image/jpeg' });
  });

  it('rejects an upload with another content type than the signed one', async () => {
    const key = originalKey(workspaceId, randomUUID());
    const upload = await store().presignPut(key, { contentType: 'image/png', expiresInSeconds: 300 });

    const response = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: jpegLike(64),
    });

    expect(response.ok).toBe(false);
    await expect(store().head(key)).resolves.toBeNull();
  });

  it('reads an object through a signed GET and directly, within a size limit', async () => {
    const key = renditionKey(workspaceId, randomUUID(), {
      profile: 'thumb_320',
      cropHash: 'full',
      extension: 'webp',
    });
    const body = jpegLike(4096);
    await store().put(key, body, { contentType: 'image/webp' });

    const url = await store().signedGetUrl(key, { expiresInSeconds: 3600 });
    const response = await fetch(url);

    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    await expect(store().get(key, { maxBytes: 4096 })).resolves.toEqual(body);
    await expect(store().get(key, { maxBytes: 1000 })).rejects.toBeInstanceOf(StorageObjectTooLargeError);
  });

  it('names the file of a signed download', async () => {
    const key = `exports/${randomUUID()}/${randomUUID()}.zip`;
    await store().put(key, new Uint8Array([0x50, 0x4b, 5, 6]), { contentType: 'application/zip' });

    const url = await store().signedGetUrl(key, {
      expiresInSeconds: 300,
      downloadName: 'social-media-poster-export-2026-10-17.zip',
    });
    const response = await fetch(url);

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="social-media-poster-export-2026-10-17.zip"',
    );
    await store().delete(key);
  });

  it('answers null for a missing object', async () => {
    await expect(store().head(originalKey(workspaceId, randomUUID()))).resolves.toBeNull();
  });

  it('deletes one object, or every object of an asset by its prefix', async () => {
    const assetId = randomUUID();
    const keys = [
      originalKey(workspaceId, assetId),
      renditionKey(workspaceId, assetId, { profile: 'thumb_320', cropHash: 'full', extension: 'webp' }),
      renditionKey(workspaceId, assetId, { profile: 'instagram_feed', cropHash: 'full', extension: 'jpg' }),
    ];
    for (const key of keys) {
      await store().put(key, jpegLike(128), { contentType: 'image/jpeg' });
    }
    const other = originalKey(workspaceId, randomUUID());
    await store().put(other, jpegLike(128), { contentType: 'image/jpeg' });

    await store().delete(keys[2] ?? '');
    await expect(store().head(keys[2] ?? '')).resolves.toBeNull();
    await expect(store().deletePrefix(assetPrefix(workspaceId, assetId))).resolves.toBe(2);

    for (const key of keys) {
      await expect(store().head(key)).resolves.toBeNull();
    }
    await expect(store().head(other)).resolves.not.toBeNull();
    await expect(store().delete(keys[0] ?? '')).resolves.toBeUndefined();
  });

  it('never deletes by a prefix outside one workspace', async () => {
    await expect(store().deletePrefix('ws/')).rejects.toBeInstanceOf(RangeError);
    await expect(store().deletePrefix('')).rejects.toBeInstanceOf(RangeError);
  });

  it('signs browser URLs for the public endpoint when one is set', async () => {
    const outside = new S3Storage({ ...config(), publicEndpoint: 'https://media.example.test' });

    const upload = await outside.presignPut(originalKey(workspaceId, randomUUID()), {
      contentType: 'image/jpeg',
      expiresInSeconds: 300,
    });
    const read = await outside.signedGetUrl('ws/x/y', { expiresInSeconds: 60 });
    outside.destroy();

    expect(new URL(upload.url).origin).toBe('https://media.example.test');
    expect(new URL(read).origin).toBe('https://media.example.test');
  });
});
