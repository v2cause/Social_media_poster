import {
  effectiveLimits,
  X_BROWSER_FLAG,
  type XBrowserFlags,
  type XBrowserScope,
  type XBrowserStore,
} from '@smp/core';

import { prismaAuditTrail, type RequestOrigin } from '../audit/prisma-audit-trail';
import { toSubscription } from '../billing/prisma-subscriptions';
import { bytesOf } from '../channels/mappers';
import type { TenantTransaction } from '../tenant-context';
import { setFlag } from './feature-flags';

// The flags and risk acknowledgements of the X browser in one workspace (guide step 6.1). The
// policies of feature_flag show the global row, the row of the organization and the rows of the
// workspace, and let the workspace write its own row only. The plan of the organization comes from
// its subscription, which the tenant reads (guide step 7.4).

export function createPrismaXBrowserStore(
  tx: TenantTransaction,
  scope: XBrowserScope,
  origin: RequestOrigin,
): XBrowserStore {
  return {
    async flags(organizationId, workspaceId): Promise<XBrowserFlags> {
      const rows = await tx.featureFlag.findMany({
        where: {
          key: X_BROWSER_FLAG,
          OR: [
            { organizationId: null, workspaceId: null },
            { organizationId, workspaceId: null },
            { workspaceId },
          ],
        },
        orderBy: { updatedAt: 'asc' },
      });
      const flags: XBrowserFlags = { global: null, organization: null, workspace: null };
      // Older rows first, so a newer duplicate wins.
      for (const row of rows) {
        if (row.workspaceId === workspaceId) {
          flags.workspace = row.enabled;
        } else if (row.workspaceId === null && row.organizationId === organizationId) {
          flags.organization = row.enabled;
        } else if (row.workspaceId === null && row.organizationId === null) {
          flags.global = row.enabled;
        }
      }
      return flags;
    },

    async planAllows(organizationId) {
      const row = await tx.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
      if (!row) {
        return false;
      }
      const subscription = toSubscription(row);
      return effectiveLimits(subscription.plan.limits, subscription.limitOverrides).xBrowserAllowed;
    },

    async setWorkspaceFlag(organizationId, workspaceId, enabled) {
      await setFlag(tx, X_BROWSER_FLAG, { organizationId, workspaceId }, enabled);
    },

    async acknowledgement(workspaceId, subject) {
      const row = await tx.riskAcknowledgement.findFirst({
        where: { workspaceId, subject, revokedAt: null },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      });
      if (!row) {
        return null;
      }
      const user = await tx.user.findUnique({ where: { id: row.userId }, select: { name: true } });
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        userId: row.userId,
        userName: user?.name ?? null,
        textVersion: row.textVersion,
        textHash: row.textHash,
        locale: row.locale,
        acceptedAt: row.acceptedAt,
      };
    },

    async acknowledge(acknowledgement) {
      await tx.riskAcknowledgement.create({ data: acknowledgement });
    },

    async revoke(workspaceId, subject, at) {
      const result = await tx.riskAcknowledgement.updateMany({
        where: { workspaceId, subject, revokedAt: null },
        data: { revokedAt: at },
      });
      return result.count;
    },

    async replaceSession(workspaceId, connectionId, externalUserId, sealed) {
      const result = await tx.socialConnection.updateMany({
        where: { id: connectionId, workspaceId, platform: 'X', method: 'BROWSER', externalUserId },
        data: { sessionSealed: bytesOf(sealed), version: { increment: 1 } },
      });
      return result.count === 1;
    },

    audit: prismaAuditTrail(tx, scope.userId, origin),
  };
}
