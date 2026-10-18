import type { ExpiredAsset, ExpiredMediaCutoffs, MediaCleanupStore } from '@smp/core';

import { Prisma } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The expired assets of the media library on PostgreSQL (guide step 8.3, ADR 0038), as
// app_system across workspaces. The partial indexes of the migration 0025_media_cleanup hold only
// removed assets and pending uploads. The deletion checks the same condition again, so an asset a
// variant took or an upload that completed in the meantime stays; the renditions go with the row.

const expiredCondition = ({ deletedBefore, pendingBefore }: ExpiredMediaCutoffs): Prisma.Sql => Prisma.sql`
  NOT EXISTS (SELECT 1 FROM post_media p WHERE p.asset_id = m.id)
  AND (m.deleted_at < ${deletedBefore}
       OR (m.status = 'PENDING_UPLOAD' AND m.created_at < ${pendingBefore}))`;

export class PrismaMediaCleanupStore implements MediaCleanupStore {
  constructor(private readonly system: SystemPrismaClient) {}

  async expired(cutoffs: ExpiredMediaCutoffs, limit: number): Promise<ExpiredAsset[]> {
    const rows = await runInSystemScope(
      () => this.system.$queryRaw<{ id: string; workspace_id: string }[]>`
        SELECT m.id, m.workspace_id FROM media_asset m
         WHERE ${expiredCondition(cutoffs)}
         ORDER BY m.created_at, m.id
         LIMIT ${limit}`,
    );
    return rows.map((row) => ({ workspaceId: row.workspace_id, assetId: row.id }));
  }

  remove(assetIds: readonly string[], cutoffs: ExpiredMediaCutoffs): Promise<number> {
    return runInSystemScope(
      () => this.system.$executeRaw`
        DELETE FROM media_asset m
         WHERE m.id = ANY(${[...assetIds]}::uuid[]) AND ${expiredCondition(cutoffs)}`,
    );
  }
}
