import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { findRlsViolations } from '../src';
import { ids, inContext } from './support/sql-context';

// Guide step 3.1: the media tables are isolated per workspace, and an asset in use cannot be
// removed while a variant still shows it.

const f = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  a1: randomUUID(),
  b1: randomUUID(),
  postA: randomUUID(),
  postB: randomUUID(),
  variantA: randomUUID(),
  variantB: randomUUID(),
  assetA: randomUUID(),
  assetB: randomUUID(),
  renditionA: randomUUID(),
  renditionB: randomUUID(),
  usageA: randomUUID(),
  usageB: randomUUID(),
};

const MEDIA_TABLES = ['media_asset', 'media_rendition', 'post_media'];

describe('row-level security of the media tables', () => {
  let database: TestDatabase | undefined;
  let runtime: Client | undefined;

  const db = (): TestDatabase => {
    if (!database) {
      throw new Error('PostgreSQL test container is not running');
    }
    return database;
  };
  const app = (): Client => {
    if (!runtime) {
      throw new Error('app_user is not connected');
    }
    return runtime;
  };
  const inA = <T>(fn: () => Promise<T>): Promise<T> =>
    inContext(app(), { organizationId: f.orgA, workspaceId: f.a1 }, fn);

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    try {
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [f.orgA, f.orgB],
      );
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'media-a1', 'A1', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'media-b1', 'B1', 'Europe/Berlin', 'en', now())`,
        [f.a1, f.orgA, f.b1, f.orgB],
      );
      for (const [ws, post, variant, asset, rendition, usage] of [
        [f.a1, f.postA, f.variantA, f.assetA, f.renditionA, f.usageA],
        [f.b1, f.postB, f.variantB, f.assetB, f.renditionB, f.usageB],
      ] as const) {
        await system.query(
          `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
          [post, ws],
        );
        await system.query(
          `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
           VALUES ($1, $2, $3, 'INSTAGRAM', 't1', now())`,
          [variant, ws, post],
        );
        await system.query(
          `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size,
                                    storage_key, mime_type, size_bytes, width, height, updated_at)
           VALUES ($1, $2, 'READY', 'photo.jpg', 'image/jpeg', 1000, $3, 'image/jpeg', 900, 1080, 1350, now())`,
          [asset, ws, `ws/${ws}/assets/${asset}/original`],
        );
        await system.query(
          `INSERT INTO media_rendition (id, workspace_id, asset_id, profile, crop_hash, storage_key, mime_type,
                                        width, height, size_bytes)
           VALUES ($1, $2, $3, 'thumb_320', 'full', $4, 'image/webp', 320, 400, 20000)`,
          [rendition, ws, asset, `ws/${ws}/assets/${asset}/renditions/thumb_320-full.webp`],
        );
        await system.query(
          `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, updated_at)
           VALUES ($1, $2, $3, $4, 0, now())`,
          [usage, ws, variant, asset],
        );
      }
    } finally {
      await system.end();
    }
    runtime = await database.connectAs('app_user');
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await database?.stop();
  });

  it('passes the RLS check with the media tables', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      await expect(findRlsViolations(owner)).resolves.toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('shows every media table of the workspace in context and nothing without it', async () => {
    for (const table of MEDIA_TABLES) {
      const inWorkspace = await inA(() => ids(app(), `SELECT id FROM ${table}`));
      const orgOnly = await inContext(app(), { organizationId: f.orgA }, () =>
        ids(app(), `SELECT id FROM ${table}`),
      );
      expect(inWorkspace, table).toHaveLength(1);
      expect(orgOnly, table).toEqual([]);
    }
    expect(await inA(() => ids(app(), 'SELECT id FROM media_asset'))).toEqual([f.assetA]);
    expect(await inA(() => ids(app(), 'SELECT id FROM post_media'))).toEqual([f.usageA]);
  });

  it('rejects writes into another workspace', async () => {
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO media_asset (id, workspace_id, file_name, declared_mime_type, declared_size, storage_key, updated_at)
           VALUES (gen_random_uuid(), $1, 'x.jpg', 'image/jpeg', 1, 'x', now())`,
          [f.b1],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const altered = await inA(() =>
      app().query(`UPDATE media_asset SET alt_text = 'hijacked' WHERE id = $1`, [f.assetB]),
    );
    expect(altered.rowCount).toBe(0);
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 1, now())`,
          [f.b1, f.variantB, f.assetA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps an asset while a variant uses it and removes the use with the variant', async () => {
    await expect(inA(() => app().query('DELETE FROM media_asset WHERE id = $1', [f.assetA]))).rejects.toThrow(
      /post_media_asset_id_fkey/,
    );
    await inA(() => app().query('DELETE FROM post_variant WHERE id = $1', [f.variantA]));
    expect(await inA(() => ids(app(), 'SELECT id FROM post_media'))).toEqual([]);
    const removed = await inA(() => app().query('DELETE FROM media_asset WHERE id = $1', [f.assetA]));
    expect(removed.rowCount).toBe(1);
    expect(await inA(() => ids(app(), 'SELECT id FROM media_rendition'))).toEqual([]);
  });
});
