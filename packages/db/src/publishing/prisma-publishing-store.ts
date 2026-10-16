import { accessExpiryOf, type PublishingScope, type PublishingStore } from '@smp/core';

import { prismaAuditTrail, type RequestOrigin } from '../audit/prisma-audit-trail';
import { toCrop } from '../media/mappers';
import type { TenantTransaction } from '../tenant-context';

// The repositories of the planning use cases on one transaction (guide step 4.6). Every method
// filters by the workspace explicitly; row-level security limits it to the scope as well. A
// status change is a conditional update on the version, so a change in between is not lost.

export function createPrismaPublishingStore(
  tx: TenantTransaction,
  scope: PublishingScope,
  origin: RequestOrigin,
): PublishingStore {
  return {
    variants: {
      async find(workspaceId, variantId) {
        const row = await tx.postVariant.findFirst({
          where: { id: variantId, workspaceId },
          select: {
            id: true,
            workspaceId: true,
            postId: true,
            platform: true,
            status: true,
            version: true,
            scheduleVersion: true,
            socialAccountId: true,
            text: true,
            hashtags: true,
            firstComment: true,
            scheduledAt: true,
            scheduledTimezone: true,
          },
        });
        return row;
      },
      async change(workspaceId, variantId, version, change) {
        const { count } = await tx.postVariant.updateMany({
          where: { id: variantId, workspaceId, version },
          data: {
            status: change.status,
            scheduledAt: change.scheduledAt,
            scheduledTimezone: change.scheduledTimezone,
            socialAccountId: change.socialAccountId,
            queuedAt: change.queuedAt,
            // A new plan starts without the traces of a former attempt.
            leaseOwner: null,
            leaseUntil: null,
            failureCode: null,
            lastError: null,
            isDryRun: false,
            version: { increment: 1 },
            scheduleVersion: { increment: 1 },
          },
        });
        if (count !== 1) {
          return null;
        }
        const row = await tx.postVariant.findFirst({
          where: { id: variantId, workspaceId },
          select: { scheduleVersion: true },
        });
        return row;
      },
    },

    targets: {
      async find(workspaceId, accountId) {
        const row = await tx.socialAccount.findFirst({
          where: { id: accountId, workspaceId },
          select: {
            id: true,
            platform: true,
            disconnectedAt: true,
            connection: {
              select: {
                status: true,
                accessTokenExpiresAt: true,
                refreshTokenExpiresAt: true,
                // Only whether there is one.
                refreshTokenSealed: true,
              },
            },
          },
        });
        return row
          ? {
              id: row.id,
              platform: row.platform,
              disconnectedAt: row.disconnectedAt,
              connectionStatus: row.connection.status,
              accessExpiresAt: accessExpiryOf({
                hasRefreshToken: row.connection.refreshTokenSealed !== null,
                accessTokenExpiresAt: row.connection.accessTokenExpiresAt,
                refreshTokenExpiresAt: row.connection.refreshTokenExpiresAt,
              }),
            }
          : null;
      },
    },

    media: {
      async sourcesOf(workspaceId, variantId) {
        const rows = await tx.postMedia.findMany({
          where: { variantId, workspaceId },
          orderBy: { position: 'asc' },
          select: {
            crop: true,
            letterbox: true,
            asset: { select: { mimeType: true, width: true, height: true } },
          },
        });
        // Only ready assets can be attached, so they have a type and a size.
        return rows.map((row) => ({
          mimeType: row.asset.mimeType ?? 'application/octet-stream',
          width: row.asset.width ?? 0,
          height: row.asset.height ?? 0,
          crop: toCrop(row.crop),
          letterbox: row.letterbox,
        }));
      },
    },

    outbox: {
      async add(workspaceId, event) {
        await tx.outboxEvent.create({
          data: { workspaceId, type: event.type, payload: event.payload },
        });
      },
    },

    audit: prismaAuditTrail(tx, scope.userId, origin),
  };
}
