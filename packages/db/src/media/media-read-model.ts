import { FULL_IMAGE, THUMBNAIL_PROFILES, type MediaRejectReason, type MediaStatus } from '@smp/core';
import { z } from 'zod';

import { InvalidCursorError } from '../audit/audit-log-read-model';
import type { WorkspaceRef } from '../content/content-read-model';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';
import { toRejectReason } from './mappers';

// The read side of the media context (guide step 3.3): what the library and the composer show.
// Thumbnails come with their storage keys; the API signs them, the original is never served.

export interface MediaThumbnailView {
  width: number;
  height: number;
  storageKey: string;
}

export interface MediaAssetView {
  id: string;
  status: MediaStatus;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  rejectReason: MediaRejectReason | null;
  altText: string | null;
  usageCount: number;
  /** Ordered by width. */
  thumbnails: MediaThumbnailView[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaListFilter {
  /** Without a status: every asset whose file arrived. */
  status?: MediaStatus;
  usage?: 'used' | 'unused';
}

// The library runs newest first; the cursor is the position of the last asset of a page.
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError();
  }
}

const assetInclude = {
  renditions: {
    where: { profile: { in: [...THUMBNAIL_PROFILES] }, cropHash: FULL_IMAGE },
    select: { width: true, height: true, storageKey: true },
    orderBy: { width: 'asc' },
  },
  _count: { select: { postMedia: true } },
} as const satisfies Prisma.MediaAssetInclude;

type AssetRow = Prisma.MediaAssetGetPayload<{ include: typeof assetInclude }>;

const toView = (row: AssetRow): MediaAssetView => ({
  id: row.id,
  status: row.status,
  fileName: row.fileName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  width: row.width,
  height: row.height,
  rejectReason: toRejectReason(row.rejectReason),
  altText: row.altText,
  usageCount: row._count.postMedia,
  thumbnails: row.renditions,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class MediaReadModel {
  constructor(private readonly base: PrismaClient) {}

  /** The library of the workspace, newest first. Deleted assets never show. */
  list(
    ref: WorkspaceRef,
    filter: MediaListFilter,
    page: { cursor?: string; limit: number },
  ): Promise<{ assets: MediaAssetView[]; nextCursor: string | null }> {
    const after = page.cursor ? decodeCursor(page.cursor) : null;
    const usage =
      filter.usage === 'used'
        ? { postMedia: { some: {} } }
        : filter.usage === 'unused'
          ? { postMedia: { none: {} } }
          : {};
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.mediaAsset.findMany({
        where: {
          workspaceId: ref.workspaceId,
          deletedAt: null,
          status: filter.status ?? { not: 'PENDING_UPLOAD' },
          ...usage,
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: new Date(after.createdAt) } },
                  { createdAt: new Date(after.createdAt), id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit + 1,
        include: assetInclude,
      });
      const assets = rows.slice(0, page.limit);
      const last = assets.at(-1);
      return {
        assets: assets.map(toView),
        nextCursor:
          rows.length > page.limit && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      };
    });
  }

  /** One asset of the library, or null when it does not exist or was deleted. */
  asset(ref: WorkspaceRef, assetId: string): Promise<MediaAssetView | null> {
    return withTenantTx(this.base, ref, async (tx) => {
      const row = await tx.mediaAsset.findFirst({
        where: { id: assetId, workspaceId: ref.workspaceId, deletedAt: null },
        include: assetInclude,
      });
      return row ? toView(row) : null;
    });
  }
}
