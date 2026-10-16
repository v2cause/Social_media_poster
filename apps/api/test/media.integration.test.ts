import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MediaAssetDto, MediaPageDto, UploadTicketDto } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, TEST_BUCKET, type ApiTestApp } from './support/api-app';
import { signIn, type Browser } from './support/browser';

// Guide step 3.3: the upload flow end to end against SeaweedFS. The browser gets a presigned PUT,
// uploads, reports completion; a consumer of the media queue processes the file like the worker
// role "media". Responses carry signed thumbnail URLs and never the original.

const SEED_PASSWORD = 'seed-password-for-the-media-test';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}`;
const MB = 1024 * 1024;

const userOf = (role: string) => {
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(`no demo user with role ${role}`);
  }
  return user;
};

const photo = (): Promise<Buffer> =>
  sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: '#336699',
      noise: { type: 'gaussian', mean: 120, sigma: 40 },
    },
  })
    .jpeg({ quality: 85 })
    .toBuffer();

describe('media API', () => {
  let api: ApiTestApp | undefined;
  let editor: Browser | undefined;
  let viewer: Browser | undefined;
  let workspaceId = '';

  const as = (browser: Browser | undefined): Browser => {
    if (!browser) {
      throw new Error('not signed in');
    }
    return browser;
  };

  /** Requests a ticket and uploads the bytes with exactly the signed headers. */
  const upload = async (
    bytes: Uint8Array,
    announced: { fileName?: string; mimeType?: string; size?: number } = {},
  ): Promise<UploadTicketDto> => {
    const response = await as(editor)
      .post(`${ws}/media/uploads`)
      .send({
        fileName: announced.fileName ?? 'photo.jpg',
        mimeType: announced.mimeType ?? 'image/jpeg',
        size: announced.size ?? bytes.byteLength,
      })
      .expect(201);
    const ticket = response.body as UploadTicketDto;
    const put = await fetch(ticket.upload.url, {
      method: ticket.upload.method,
      headers: ticket.upload.headers,
      // A copy on its own ArrayBuffer, as fetch takes it.
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    return ticket;
  };

  const complete = async (assetId: string): Promise<MediaAssetDto> =>
    (await as(editor).post(`${ws}/media/${assetId}/complete`).expect(200)).body as MediaAssetDto;

  /** Waits until the media consumer is done with the asset. */
  const settled = async (assetId: string): Promise<MediaAssetDto> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const asset = (await as(editor).get(`${ws}/media/${assetId}`).expect(200)).body as MediaAssetDto;
      if (asset.status !== 'PROCESSING' || Date.now() > deadline) {
        return asset;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const objectExists = async (key: string): Promise<boolean> => {
    const storage = api?.objectStorage;
    if (!storage) {
      throw new Error('no object storage');
    }
    const client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: true,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    });
    try {
      await client.send(new HeadObjectCommand({ Bucket: TEST_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    } finally {
      client.destroy();
    }
  };

  beforeAll(async () => {
    api = await startApiTestApp({ objectStorage: true, env: { MEDIA_STORAGE_LIMIT_BYTES: String(45 * MB) } });
    const system = createPrismaClient(api.database.url('app_system'));
    try {
      await seedDemoData(system, SEED_PASSWORD);
      const workspace = await system.workspace.findFirstOrThrow({ where: { slug: DEMO_WORKSPACE_SLUG } });
      workspaceId = workspace.id;
    } finally {
      await system.$disconnect();
    }
    editor = await signIn(api, userOf('EDITOR').email, SEED_PASSWORD);
    viewer = await signIn(api, userOf('VIEWER').email, SEED_PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await api?.close();
  });

  it('uploads a photo through a presigned URL and serves signed WebP thumbnails', async () => {
    const bytes = await photo();
    const ticket = await upload(bytes, { fileName: 'Team beim Sommerfest.jpg' });
    expect(ticket.asset).toMatchObject({ status: 'PENDING_UPLOAD', fileName: 'Team beim Sommerfest.jpg' });
    expect(ticket.upload.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(new Date(ticket.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);

    expect(['PROCESSING', 'READY']).toContain((await complete(ticket.asset.id)).status);
    const ready = await settled(ticket.asset.id);

    expect(ready).toMatchObject({
      status: 'READY',
      mimeType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      width: 1600,
      height: 1200,
      rejectReason: null,
      usageCount: 0,
    });
    expect(ready.thumbnails.map(({ width, height }) => [width, height])).toEqual([
      [320, 240],
      [640, 480],
    ]);
    for (const thumbnail of ready.thumbnails) {
      const response = await fetch(thumbnail.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      expect(thumbnail.url).toContain('X-Amz-Signature=');
      expect(thumbnail.url).not.toContain('/original');
    }
    expect(JSON.stringify(ready)).not.toMatch(/storageKey|\/original/);

    const library = (await as(viewer).get(`${ws}/media`).expect(200)).body as MediaPageDto;
    expect(library.assets.map(({ id }) => id)).toContain(ticket.asset.id);
  });

  it('rejects a file that is no image, whatever it is called, and deletes it', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>not a photo</body></html>');
    const ticket = await upload(html, { fileName: 'urlaub.jpg' });

    await complete(ticket.asset.id);
    const rejected = await settled(ticket.asset.id);

    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'NOT_AN_IMAGE', thumbnails: [] });
    expect(await objectExists(`ws/${workspaceId}/assets/${ticket.asset.id}/original`)).toBe(false);
    const rejectedOnly = (await as(editor).get(`${ws}/media?status=REJECTED`).expect(200))
      .body as MediaPageDto;
    expect(rejectedOnly.assets.map(({ id }) => id)).toEqual([ticket.asset.id]);
  });

  it('checks the announced type and size before it signs an upload', async () => {
    const refuse = (body: object) => as(editor).post(`${ws}/media/uploads`).send(body);

    expect((await refuse({ fileName: 'logo.svg', mimeType: 'image/svg+xml', size: 100 })).body).toMatchObject(
      {
        status: 422,
        code: 'MEDIA_TYPE_NOT_ALLOWED',
      },
    );
    expect((await refuse({ fileName: 'scan.heic', mimeType: 'image/heic', size: 100 })).body).toMatchObject({
      code: 'MEDIA_TYPE_NOT_ALLOWED',
    });
    expect(
      (await refuse({ fileName: 'huge.jpg', mimeType: 'image/jpeg', size: 20 * MB + 1 })).body,
    ).toMatchObject({ status: 422, code: 'MEDIA_TOO_LARGE' });
    expect((await refuse({ fileName: 'empty.jpg', mimeType: 'image/jpeg', size: 0 })).body).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('answers 409 before the file arrived and rejects a file other than announced', async () => {
    const pending = (
      await as(editor)
        .post(`${ws}/media/uploads`)
        .send({ fileName: 'later.jpg', mimeType: 'image/jpeg', size: 1000 })
        .expect(201)
    ).body as UploadTicketDto;
    expect(
      (await as(editor).post(`${ws}/media/${pending.asset.id}/complete`).expect(409)).body,
    ).toMatchObject({ code: 'MEDIA_UPLOAD_MISSING' });

    // The content type is part of the signature; the size is checked at completion.
    const wrongType = await fetch(pending.upload.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: '<html></html>',
    });
    expect(wrongType.status).toBe(403);
    const bigger = await upload(await photo(), { size: 1000 });
    const mismatch = await complete(bigger.asset.id);
    expect(mismatch).toMatchObject({ status: 'REJECTED', rejectReason: 'SIZE_MISMATCH' });
    expect(await objectExists(`ws/${workspaceId}/assets/${bigger.asset.id}/original`)).toBe(false);
  });

  it('keeps the uploads of a workspace within its storage quota', async () => {
    // 45 MB in this test app; the photos above used a few hundred KB.
    const request = () =>
      as(editor)
        .post(`${ws}/media/uploads`)
        .send({ fileName: 'big.png', mimeType: 'image/png', size: 20 * MB });

    await request().expect(201);
    await request().expect(201);
    expect((await request().expect(402)).body).toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
  });

  it('changes the alt text with optimistic locking, deletes media and lets viewers only read', async () => {
    const ticket = await upload(await photo());
    await complete(ticket.asset.id);
    const asset = await settled(ticket.asset.id);
    const path = `${ws}/media/${asset.id}`;

    const changed = (
      await as(editor)
        .patch(path)
        .send({ version: asset.version, altText: '  Das Team beim Sommerfest  ' })
        .expect(200)
    ).body as MediaAssetDto;
    expect(changed).toMatchObject({ altText: 'Das Team beim Sommerfest', version: asset.version + 1 });
    expect(
      (await as(editor).patch(path).send({ version: asset.version, altText: 'stale' }).expect(409)).body,
    ).toMatchObject({ code: 'VERSION_CONFLICT' });

    await as(viewer).get(path).expect(200);
    expect(
      (await as(viewer).patch(path).send({ version: changed.version, altText: 'x' }).expect(403)).body,
    ).toMatchObject({ code: 'NOT_PERMITTED' });
    await as(viewer).delete(path).expect(403);

    await as(editor).delete(path).expect(204);
    expect((await as(editor).get(path).expect(404)).body).toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await as(editor).delete(path).expect(404);
  });
});
