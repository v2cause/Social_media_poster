import type { MediaScope, MediaStore } from '@smp/core';

import { prismaAuditTrail, type RequestOrigin } from '../audit/prisma-audit-trail';
import { Prisma } from '../generated/prisma/client';
import type { TenantTransaction } from '../tenant-context';
import { toMediaAsset, toMediaRendition, toPostMedia } from './mappers';

// The repositories of the media context on one transaction (guide step 3.3). Every method filters
// by the workspace explicitly; row-level security limits it to the scope as well. Status changes
// are conditional updates, so a job that comes late changes nothing.

export function createPrismaMediaStore(
  tx: TenantTransaction,
  scope: MediaScope,
  origin: RequestOrigin,
): MediaStore {
  const bump = { version: { increment: 1 } } as const;

  return {
    assets: {
      async find(workspaceId, assetId) {
        const row = await tx.mediaAsset.findFirst({ where: { id: assetId, workspaceId } });
        return row ? toMediaAsset(row) : null;
      },
      async insert(asset) {
        await tx.mediaAsset.create({ data: asset });
      },
      async lockStorage(workspaceId) {
        // Held until the transaction ends. Uploads of other workspaces do not wait; a collision of
        // the hash only makes two of them wait for each other.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media.storage.${workspaceId}`}, 0))`;
      },
      async storageUsed(workspaceId) {
        // The measured size once the file arrived, the announced one before.
        const rows = await tx.$queryRaw<{ used: bigint }[]>`
          SELECT COALESCE(SUM(COALESCE(size_bytes, declared_size)), 0)::bigint AS used
            FROM media_asset
           WHERE workspace_id = ${workspaceId}::uuid
             AND deleted_at IS NULL
             AND status <> 'REJECTED'`;
        return Number(rows[0]?.used ?? 0n);
      },
      async startProcessing(workspaceId, assetId, sizeBytes) {
        const { count } = await tx.mediaAsset.updateMany({
          where: { id: assetId, workspaceId, status: 'PENDING_UPLOAD' },
          data: { status: 'PROCESSING', sizeBytes, ...bump },
        });
        return count === 1;
      },
      async finishProcessing(workspaceId, assetId, result) {
        const { count } = await tx.mediaAsset.updateMany({
          where: { id: assetId, workspaceId, status: 'PROCESSING' },
          data: {
            status: 'READY',
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
            sha256: result.sha256,
            processedAt: result.processedAt,
            ...bump,
          },
        });
        return count === 1;
      },
      async reject(workspaceId, assetId, reason, sizeBytes) {
        const { count } = await tx.mediaAsset.updateMany({
          where: { id: assetId, workspaceId, status: { in: ['PENDING_UPLOAD', 'PROCESSING'] } },
          data: { status: 'REJECTED', rejectReason: reason, sizeBytes, ...bump },
        });
        return count === 1;
      },
      async updateAltText(workspaceId, assetId, version, altText) {
        const { count } = await tx.mediaAsset.updateMany({
          where: { id: assetId, workspaceId, version },
          data: { altText, ...bump },
        });
        return count === 1;
      },
      async markDeleted(workspaceId, assetId, deletedAt) {
        await tx.mediaAsset.updateMany({
          where: { id: assetId, workspaceId, deletedAt: null },
          data: { deletedAt, ...bump },
        });
      },
      usageCount(workspaceId, assetId) {
        return tx.postMedia.count({ where: { assetId, workspaceId } });
      },
    },

    renditions: {
      async find(workspaceId, assetId, profile, cropHash) {
        const row = await tx.mediaRendition.findFirst({ where: { assetId, profile, cropHash, workspaceId } });
        return row ? toMediaRendition(row) : null;
      },
      async upsert(rendition) {
        const { assetId, profile, cropHash, workspaceId } = rendition;
        await tx.mediaRendition.upsert({
          where: { assetId_profile_cropHash: { assetId, profile, cropHash }, workspaceId },
          create: rendition,
          update: {
            storageKey: rendition.storageKey,
            mimeType: rendition.mimeType,
            width: rendition.width,
            height: rendition.height,
            sizeBytes: rendition.sizeBytes,
          },
        });
      },
    },

    postMedia: {
      async find(workspaceId, postMediaId) {
        const row = await tx.postMedia.findFirst({ where: { id: postMediaId, workspaceId } });
        return row ? toPostMedia(row) : null;
      },
      async ofVariant(workspaceId, variantId) {
        const rows = await tx.postMedia.findMany({
          where: { variantId, workspaceId },
          orderBy: { position: 'asc' },
        });
        return rows.map(toPostMedia);
      },
      async replace(workspaceId, variantId, items) {
        await tx.postMedia.deleteMany({ where: { variantId, workspaceId } });
        if (items.length > 0) {
          await tx.postMedia.createMany({
            data: items.map((item) => ({
              ...item,
              // A copy as a plain object, which Prisma accepts as JSON; SQL NULL for the whole image.
              crop: item.crop ? { ...item.crop } : Prisma.DbNull,
            })),
          });
        }
      },
    },

    variants: {
      find(workspaceId, variantId) {
        return tx.postVariant.findFirst({
          where: { id: variantId, workspaceId },
          select: { id: true, platform: true, status: true, version: true },
        });
      },
      async touch(workspaceId, variantId, version) {
        const { count } = await tx.postVariant.updateMany({
          where: { id: variantId, workspaceId, version },
          data: bump,
        });
        return count === 1;
      },
    },

    audit: prismaAuditTrail(tx, scope.userId ?? undefined, origin),
  };
}
