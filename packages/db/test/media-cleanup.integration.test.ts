import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSystemPrismaClient, PrismaMediaCleanupStore, type SystemPrismaClient } from '../src';
import { createOrganization, type TestOrganization } from './support/organization-fixtures';

// Guide step 8.3 with architecture 9 on PostgreSQL: the store finds the assets removed from the
// library before a moment and the uploads still pending since before another, across
// workspaces, leaves an asset a variant uses, and deletes the rows with their renditions only
// while they are still expired.

const NOW = new Date('2026-10-18T05:00:00Z');
const HOUR = 60 * 60 * 1000;
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR);
const cutoffs = { deletedBefore: hoursAgo(30 * 24), pendingBefore: hoursAgo(24) };

describe('the media clean-up store on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let system: SystemPrismaClient | undefined;
  let fixtures: Client | undefined;
  const first: TestOrganization = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };
  const second: TestOrganization = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };
  const ids = {
    removedOld: randomUUID(),
    removedRecent: randomUUID(),
    removedUsed: randomUUID(),
    pendingOld: randomUUID(),
    pendingRecent: randomUUID(),
    ready: randomUUID(),
  };

  const clients = () => {
    if (!system || !fixtures) {
      throw new Error('not started');
    }
    return { store: new PrismaMediaCleanupStore(system), sql: fixtures };
  };
  const insertAsset = async (
    id: string,
    workspaceId: string,
    values: { status: string; createdAt: Date; deletedAt: Date | null },
  ): Promise<void> => {
    await clients().sql.query(
      `INSERT INTO media_asset (id, workspace_id, status, file_name, declared_mime_type, declared_size, storage_key,
                                created_at, deleted_at, updated_at)
       VALUES ($1, $2, $3, 'photo.jpg', 'image/jpeg', 1234, $4, $5, $6, now())`,
      [
        id,
        workspaceId,
        values.status,
        `ws/${workspaceId}/assets/${id}/original`,
        values.createdAt,
        values.deletedAt,
      ],
    );
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    fixtures = await database.connectAs('app_system');
    await createOrganization(fixtures, first, { name: 'First', slug: 'first', email: 'owner@first.test' });
    await createOrganization(fixtures, second, {
      name: 'Second',
      slug: 'second',
      email: 'owner@second.test',
    });
    system = createSystemPrismaClient(database.url('app_system'));

    await insertAsset(ids.removedOld, first.workspaceId, {
      status: 'READY',
      createdAt: hoursAgo(24 * 90),
      deletedAt: hoursAgo(24 * 31),
    });
    await insertAsset(ids.removedRecent, first.workspaceId, {
      status: 'READY',
      createdAt: hoursAgo(24 * 90),
      deletedAt: hoursAgo(24 * 29),
    });
    await insertAsset(ids.removedUsed, first.workspaceId, {
      status: 'READY',
      createdAt: hoursAgo(24 * 80),
      deletedAt: hoursAgo(24 * 60),
    });
    await insertAsset(ids.pendingOld, second.workspaceId, {
      status: 'PENDING_UPLOAD',
      createdAt: hoursAgo(25),
      deletedAt: null,
    });
    await insertAsset(ids.pendingRecent, second.workspaceId, {
      status: 'PENDING_UPLOAD',
      createdAt: hoursAgo(23),
      deletedAt: null,
    });
    await insertAsset(ids.ready, second.workspaceId, {
      status: 'READY',
      createdAt: hoursAgo(24 * 365),
      deletedAt: null,
    });
    await fixtures.query(
      `INSERT INTO media_rendition (id, workspace_id, asset_id, profile, crop_hash, storage_key, mime_type, width,
                                    height, size_bytes)
       VALUES ($1, $2, $3, 'thumb_320', 'full', $4, 'image/webp', 320, 240, 1000)`,
      [
        randomUUID(),
        first.workspaceId,
        ids.removedOld,
        `ws/${first.workspaceId}/assets/${ids.removedOld}/thumb`,
      ],
    );
    // A variant still uses an asset that was removed in the same moment it was attached.
    const post = randomUUID();
    const variant = randomUUID();
    await fixtures.query(
      `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
      [post, first.workspaceId],
    );
    await fixtures.query(
      `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, updated_at)
       VALUES ($1, $2, $3, 'X', $4, now())`,
      [variant, first.workspaceId, post, `x:${variant}`],
    );
    await fixtures.query(
      `INSERT INTO post_media (id, workspace_id, variant_id, asset_id, position, updated_at)
       VALUES ($1, $2, $3, $4, 0, now())`,
      [randomUUID(), first.workspaceId, variant, ids.removedUsed],
    );
  }, 300_000);

  afterAll(async () => {
    await Promise.all([system?.$disconnect(), fixtures?.end()]);
    await database?.stop();
  });

  it('finds the expired assets across workspaces, the oldest first', async () => {
    const { store } = clients();

    await expect(store.expired(cutoffs, 10)).resolves.toEqual([
      { workspaceId: first.workspaceId, assetId: ids.removedOld },
      { workspaceId: second.workspaceId, assetId: ids.pendingOld },
    ]);
    await expect(store.expired(cutoffs, 1)).resolves.toEqual([
      { workspaceId: first.workspaceId, assetId: ids.removedOld },
    ]);
  });

  it('deletes the rows with their renditions, and only while they are still expired', async () => {
    const { store, sql } = clients();
    // The upload completed in the meantime.
    await sql.query(`UPDATE media_asset SET status = 'PROCESSING' WHERE id = $1`, [ids.pendingOld]);

    await expect(store.remove([ids.removedOld, ids.pendingOld, ids.ready], cutoffs)).resolves.toBe(1);

    const left = await sql.query<{ id: string }>(`SELECT id FROM media_asset ORDER BY created_at`);
    expect(left.rows.map((row) => row.id).sort()).toEqual(
      [ids.removedRecent, ids.removedUsed, ids.pendingOld, ids.pendingRecent, ids.ready].sort(),
    );
    const renditions = await sql.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM media_rendition WHERE asset_id = $1`,
      [ids.removedOld],
    );
    expect(renditions.rows[0]?.count).toBe(0);
    await expect(store.expired(cutoffs, 10)).resolves.toEqual([]);
  });
});
