import { randomUUID } from 'node:crypto';

import { CreateBucketCommand, ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { assetPrefix, exportPrefixOf, originalKey, renditionKey, workspacePrefix } from '@smp/core';
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

  it('stores a stream of unknown length in parts and keeps nothing of a stream that failed', async () => {
    const key = `exports/${randomUUID()}/${randomUUID()}.zip`;
    const MIB = 1024 * 1024;
    // Eleven chunks of one MiB: two full parts of five MiB and a last one of one MiB.
    const chunks = Array.from({ length: 11 }, (_, index) => new Uint8Array(MIB).fill(index));
    async function* stream(failAfter?: number): AsyncGenerator<Uint8Array> {
      for (const [index, chunk] of chunks.entries()) {
        if (index === failAfter) {
          throw new Error('the archive broke');
        }
        await Promise.resolve();
        yield chunk;
      }
    }

    await expect(
      store().putStream(key, stream(), { contentType: 'application/zip', partBytes: 5 * MIB }),
    ).resolves.toEqual({ bytes: 11 * MIB });
    const stored = await store().get(key, { maxBytes: 12 * MIB });
    expect(stored.byteLength).toBe(11 * MIB);
    expect([stored[0], stored[5 * MIB], stored[11 * MIB - 1]]).toEqual([0, 5, 10]);
    await expect(store().head(key)).resolves.toMatchObject({ contentType: 'application/zip' });

    const broken = `exports/${randomUUID()}/${randomUUID()}.zip`;
    await expect(
      store().putStream(broken, stream(7), { contentType: 'application/zip', partBytes: 5 * MIB }),
    ).rejects.toThrow('the archive broke');
    await expect(store().head(broken)).resolves.toBeNull();
    const admin = new S3Client({
      endpoint: config().endpoint,
      region: config().region,
      forcePathStyle: true,
      credentials: { accessKeyId: config().accessKeyId, secretAccessKey: config().secretAccessKey },
    });
    try {
      const uploads = await admin.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: broken }));
      expect(uploads.Uploads ?? []).toEqual([]);
    } finally {
      admin.destroy();
    }
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
    await expect(store().deletePrefix('exports/')).rejects.toBeInstanceOf(RangeError);
    await expect(store().deletePrefix(`ws/${randomUUID()}`)).rejects.toBeInstanceOf(RangeError);
  });

  it('deletes a whole workspace and the exports of an organization for the erasure (guide step 8.2)', async () => {
    const workspaceId = randomUUID();
    const organizationId = randomUUID();
    const kept = originalKey(randomUUID(), randomUUID());
    const keys = [
      originalKey(workspaceId, randomUUID()),
      renditionKey(workspaceId, randomUUID(), { profile: 'thumb', cropHash: 'crop', extension: 'webp' }),
      `exports/${organizationId}/${randomUUID()}.zip`,
    ];
    for (const key of [...keys, kept]) {
      await store().put(key, jpegLike(64), { contentType: 'image/jpeg' });
    }

    await expect(store().countPrefix(workspacePrefix(workspaceId))).resolves.toBe(2);
    await expect(store().deletePrefix(workspacePrefix(workspaceId))).resolves.toBe(2);
    await expect(store().deletePrefix(exportPrefixOf(organizationId))).resolves.toBe(1);
    await expect(store().countPrefix(workspacePrefix(workspaceId))).resolves.toBe(0);
    await expect(store().countPrefix('ws/')).rejects.toBeInstanceOf(RangeError);

    for (const key of keys) {
      await expect(store().head(key)).resolves.toBeNull();
    }
    await expect(store().head(kept)).resolves.not.toBeNull();
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
