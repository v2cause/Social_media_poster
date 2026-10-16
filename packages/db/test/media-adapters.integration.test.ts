import { randomUUID } from 'node:crypto';

import {
  CompleteUpload,
  DeleteMedia,
  MediaInUseError,
  MediaNotFoundError,
  ProcessAsset,
  RequestUpload,
  StorageQuotaExceededError,
  systemClock,
  UpdateMediaAltText,
  uuidV7Ids,
  VersionConflictError,
  type ContentActor,
  type EncodedImage,
  type EncodeOptions,
  type ImageProcessor,
  type MediaDependencies,
  type MediaJob,
  type PresignedUpload,
  type StoragePort,
  type StoredObject,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, MediaReadModel, PrismaMediaUnitOfWork, type PrismaClient } from '../src';

// The Prisma adapters of the media ports against PostgreSQL with row-level security: the use cases
// of the core run unchanged, the storage quota holds under parallel uploads, and the read model
// shows what the library needs. Storage, queue and image processor are fakes here; their
// adapters have tests of their own.

const orgA = randomUUID();
const orgB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const MB = 1024 * 1024;

const actor = (role: ContentActor['role'], workspaceId = workspaceA): ContentActor => ({
  userId: randomUUID(),
  organizationId: workspaceId === workspaceA ? orgA : orgB,
  workspaceId,
  role,
});
const editor = actor('EDITOR');
const refA = { organizationId: orgA, workspaceId: workspaceA };
const refB = { organizationId: orgB, workspaceId: workspaceB };

/** The first bytes of a JPEG, enough for the magic byte check. */
const jpeg = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

class MapStorage implements StoragePort {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  presignPut(key: string, options: { contentType: string }): Promise<PresignedUpload> {
    return Promise.resolve({
      url: `https://storage.test/${key}`,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
    });
  }
  head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { size: object.bytes.byteLength, contentType: object.contentType } : null,
    );
  }
  signedGetUrl(key: string): Promise<string> {
    return Promise.resolve(`https://storage.test/${key}?signed`);
  }
  get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    return object ? Promise.resolve(object.bytes) : Promise.reject(new Error(`no object ${key}`));
  }
  put(key: string, bytes: Uint8Array, options: { contentType: string }): Promise<void> {
    this.objects.set(key, { bytes, contentType: options.contentType });
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
  deletePrefix(prefix: string): Promise<number> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    keys.forEach((key) => this.objects.delete(key));
    return Promise.resolve(keys.length);
  }
}

/** A 2000 x 1500 image; encodings scale it into their box. */
const processor: ImageProcessor = {
  inspect: () => Promise.resolve({ format: 'jpeg', width: 2000, height: 1500, frames: 1 }),
  encode: (_bytes: Uint8Array, options: EncodeOptions): Promise<EncodedImage> => {
    const scale = Math.min(1, options.maxWidth / 2000, options.maxHeight / 1500);
    return Promise.resolve({
      bytes: new Uint8Array(100),
      mimeType: `image/${options.format}`,
      width: Math.round(2000 * scale),
      height: Math.round(1500 * scale),
    });
  },
  sha256: () => 'a'.repeat(64),
};

describe('media adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  const storage = new MapStorage();
  const jobs: MediaJob[] = [];

  const client = (): PrismaClient => {
    if (!base) {
      throw new Error('database not ready');
    }
    return base;
  };
  const deps = (storageBytes = 100 * MB): MediaDependencies => ({
    unitOfWork: new PrismaMediaUnitOfWork(client(), () => ({ ipAddress: '192.0.2.1', userAgent: 'vitest' })),
    storage,
    jobs: {
      process: (job) => {
        jobs.push(job);
        return Promise.resolve();
      },
    },
    processor,
    limits: { storageBytes },
    clock: systemClock,
    ids: uuidV7Ids,
  });
  const readModel = (): MediaReadModel => new MediaReadModel(client());

  /** Requests an upload, stores the file and reports it complete. */
  const upload = async (who: ContentActor, size = 2 * MB, fileName = 'photo.jpg') => {
    const ticket = await new RequestUpload(deps()).execute({
      actor: who,
      fileName,
      mimeType: 'image/jpeg',
      size,
    });
    await storage.put(ticket.asset.storageKey, jpeg(size), { contentType: 'image/jpeg' });
    return new CompleteUpload(deps()).execute({ actor: who, assetId: ticket.asset.id });
  };

  const system = async <T>(
    fn: (query: (sql: string, values: unknown[]) => Promise<unknown>) => Promise<T>,
  ) => {
    if (!database) {
      throw new Error('database not ready');
    }
    const connection = await database.connectAs('app_system');
    try {
      return await fn((sql, values) => connection.query(sql, values));
    } finally {
      await connection.end();
    }
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    await system(async (query) => {
      await query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [orgA, orgB],
      );
      await query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'media-adapters-a', 'A', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'media-adapters-b', 'B', 'Europe/Berlin', 'en', now())`,
        [workspaceA, orgA, workspaceB, orgB],
      );
    });
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('takes an upload from the request to a ready asset with two thumbnails', async () => {
    const ticket = await new RequestUpload(deps()).execute({
      actor: editor,
      fileName: 'Sommerfest.jpg',
      mimeType: 'image/jpeg',
      size: 3 * MB,
    });
    expect(await readModel().asset(refA, ticket.asset.id)).toMatchObject({ status: 'PENDING_UPLOAD' });
    // The library shows only assets whose file arrived.
    expect((await readModel().list(refA, {}, { limit: 50 })).assets.map((asset) => asset.id)).not.toContain(
      ticket.asset.id,
    );

    await storage.put(ticket.asset.storageKey, jpeg(3 * MB), { contentType: 'image/jpeg' });
    const processing = await new CompleteUpload(deps()).execute({ actor: editor, assetId: ticket.asset.id });
    expect(processing).toMatchObject({ status: 'PROCESSING', sizeBytes: 3 * MB, version: 1 });
    expect(jobs.at(-1)).toEqual({ organizationId: orgA, workspaceId: workspaceA, assetId: ticket.asset.id });

    await expect(
      new ProcessAsset(deps()).execute({
        organizationId: orgA,
        workspaceId: workspaceA,
        assetId: ticket.asset.id,
      }),
    ).resolves.toBe('READY');

    const ready = await readModel().asset(refA, ticket.asset.id);
    expect(ready).toMatchObject({
      status: 'READY',
      fileName: 'Sommerfest.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 3 * MB,
      width: 2000,
      height: 1500,
      rejectReason: null,
      usageCount: 0,
      version: 2,
    });
    expect(ready?.thumbnails).toEqual([
      {
        width: 320,
        height: 240,
        storageKey: `ws/${workspaceA}/assets/${ticket.asset.id}/renditions/thumb_320-full.webp`,
      },
      {
        width: 640,
        height: 480,
        storageKey: `ws/${workspaceA}/assets/${ticket.asset.id}/renditions/thumb_640-full.webp`,
      },
    ]);
    // A second job for the same asset changes nothing.
    await expect(
      new ProcessAsset(deps()).execute({
        organizationId: orgA,
        workspaceId: workspaceA,
        assetId: ticket.asset.id,
      }),
    ).resolves.toBe('SKIPPED');
  });

  it('keeps parallel uploads of a workspace within its storage quota', async () => {
    const quotaActor = actor('EDITOR', workspaceB);
    const requests = Array.from({ length: 5 }, () =>
      new RequestUpload(deps(25 * MB)).execute({
        actor: quotaActor,
        fileName: 'big.png',
        mimeType: 'image/png',
        size: 10 * MB,
      }),
    );

    const results = await Promise.allSettled(requests);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(3);
    for (const result of refused) {
      expect(result.reason).toBeInstanceOf(StorageQuotaExceededError);
    }
  });

  it('frees the quota of rejected files and hides assets of other workspaces', async () => {
    const ticket = await new RequestUpload(deps()).execute({
      actor: editor,
      fileName: 'liar.jpg',
      mimeType: 'image/jpeg',
      size: 1000,
    });
    await storage.put(ticket.asset.storageKey, jpeg(5000), { contentType: 'image/jpeg' });

    const rejected = await new CompleteUpload(deps()).execute({ actor: editor, assetId: ticket.asset.id });

    expect(rejected).toMatchObject({ status: 'REJECTED', rejectReason: 'SIZE_MISMATCH', sizeBytes: 5000 });
    expect(storage.objects.has(ticket.asset.storageKey)).toBe(false);
    expect(await readModel().list(refA, { status: 'REJECTED' }, { limit: 10 })).toMatchObject({
      assets: [{ id: ticket.asset.id, rejectReason: 'SIZE_MISMATCH', thumbnails: [] }],
    });
    await expect(
      new CompleteUpload(deps()).execute({ actor: actor('EDITOR', workspaceB), assetId: ticket.asset.id }),
    ).rejects.toBeInstanceOf(MediaNotFoundError);
    expect(await readModel().asset(refB, ticket.asset.id)).toBeNull();
  });

  it('changes the alt text with optimistic locking and keeps assets a variant uses', async () => {
    const used = await upload(editor);
    const unused = await upload(editor);
    const postId = randomUUID();
    const variantId = randomUUID();
    await system(async (query) => {
      await query(`INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`, [
        postId,
        workspaceA,
      ]);
      await query(
        `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
         VALUES ($1, $2, $3, 'INSTAGRAM', 't1', now())`,
        [variantId, workspaceA, postId],
      );
      await query(
        `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 0, now())`,
        [workspaceA, variantId, used.id],
      );
    });

    const changed = await new UpdateMediaAltText(deps()).execute({
      actor: editor,
      assetId: used.id,
      version: used.version,
      altText: 'Das Team beim Sommerfest',
    });
    expect(changed).toMatchObject({ altText: 'Das Team beim Sommerfest', version: used.version + 1 });
    await expect(
      new UpdateMediaAltText(deps()).execute({
        actor: editor,
        assetId: used.id,
        version: used.version,
        altText: 'stale',
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const usedIds = (await readModel().list(refA, { usage: 'used' }, { limit: 50 })).assets.map(
      ({ id }) => id,
    );
    const unusedIds = (await readModel().list(refA, { usage: 'unused' }, { limit: 50 })).assets.map(
      ({ id }) => id,
    );
    expect(usedIds).toEqual([used.id]);
    expect(unusedIds).toContain(unused.id);
    expect(unusedIds).not.toContain(used.id);
    expect(await readModel().asset(refA, used.id)).toMatchObject({ usageCount: 1 });

    await expect(new DeleteMedia(deps()).execute({ actor: editor, assetId: used.id })).rejects.toBeInstanceOf(
      MediaInUseError,
    );
    await new DeleteMedia(deps()).execute({ actor: editor, assetId: unused.id });
    expect(await readModel().asset(refA, unused.id)).toBeNull();
    const audit = await system(
      async (query) =>
        (await query(`SELECT action, actor_user_id, ip_address FROM audit_log WHERE target_id = $1`, [
          unused.id,
        ])) as { rows: unknown[] },
    );
    expect(audit.rows).toEqual([
      { action: 'media.delete', actor_user_id: editor.userId, ip_address: '192.0.2.1' },
    ]);
  });

  it('pages through the library newest first', async () => {
    const pager = actor('EDITOR', workspaceB);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push((await upload(pager, 1000, `page-${String(index)}.jpg`)).id);
    }
    const all = (await readModel().list(refB, {}, { limit: 100 })).assets.map(({ id }) => id);

    const first = await readModel().list(refB, {}, { limit: 2 });
    const second = await readModel().list(refB, {}, { limit: 100, cursor: first.nextCursor ?? '' });

    expect(all.slice(0, 3)).toEqual([...ids].reverse());
    expect([...first.assets, ...second.assets].map(({ id }) => id)).toEqual(all);
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
  });
});
