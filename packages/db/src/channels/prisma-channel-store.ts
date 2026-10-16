import type { ChannelScope, ChannelStore, ConnectionGrant } from '@smp/core';

import { prismaAuditTrail, type RequestOrigin } from '../audit/prisma-audit-trail';
import type { TenantTransaction } from '../tenant-context';
import { bytesOf, toSocialAccount, toSocialConnection } from './mappers';
import { clearReauthMarks } from './reauth';

// The repositories of the channels context on one transaction (guide step 4.5). Every method
// filters by the workspace explicitly; row-level security limits it to the scope as well.

const grantData = (grant: ConnectionGrant) => ({
  displayName: grant.displayName,
  accessTokenSealed: bytesOf(grant.accessTokenSealed),
  refreshTokenSealed: grant.refreshTokenSealed ? bytesOf(grant.refreshTokenSealed) : null,
  accessTokenExpiresAt: grant.accessTokenExpiresAt,
  refreshTokenExpiresAt: grant.refreshTokenExpiresAt,
  scopes: grant.scopes,
  connectedById: grant.connectedById,
  lastRefreshedAt: grant.grantedAt,
});

export function createPrismaChannelStore(
  tx: TenantTransaction,
  scope: ChannelScope,
  origin: RequestOrigin,
): ChannelStore {
  const bump = { version: { increment: 1 } } as const;

  return {
    connections: {
      async find(workspaceId, connectionId) {
        const row = await tx.socialConnection.findFirst({ where: { id: connectionId, workspaceId } });
        return row ? toSocialConnection(row) : null;
      },
      async findByExternalUser(workspaceId, platform, method, externalUserId) {
        const row = await tx.socialConnection.findFirst({
          where: { workspaceId, platform, method, externalUserId },
        });
        return row ? toSocialConnection(row) : null;
      },
      async insert(connection) {
        await tx.socialConnection.create({
          data: {
            id: connection.id,
            workspaceId: connection.workspaceId,
            platform: connection.platform,
            method: connection.method,
            externalUserId: connection.externalUserId,
            ...grantData(connection),
          },
        });
      },
      async replaceGrant(workspaceId, connectionId, grant) {
        // A new grant starts the expiry reminders afresh and takes the marks off the scheduled
        // variants (guide step 4.9).
        await tx.socialConnection.updateMany({
          where: { id: connectionId, workspaceId },
          data: {
            ...grantData(grant),
            status: 'ACTIVE',
            statusReason: null,
            expiryNoticeDays: null,
            ...bump,
          },
        });
        await clearReauthMarks(tx, workspaceId, connectionId);
      },
      async revoke(workspaceId, connectionId) {
        await tx.socialConnection.updateMany({
          where: { id: connectionId, workspaceId },
          data: {
            status: 'REVOKED',
            statusReason: 'DISCONNECTED',
            accessTokenSealed: null,
            refreshTokenSealed: null,
            sessionSealed: null,
            ...bump,
          },
        });
      },
    },

    accounts: {
      async find(workspaceId, accountId) {
        const row = await tx.socialAccount.findFirst({ where: { id: accountId, workspaceId } });
        return row ? toSocialAccount(row) : null;
      },
      async findByExternalIds(workspaceId, platform, externalIds) {
        const rows = await tx.socialAccount.findMany({
          where: { workspaceId, platform, externalId: { in: [...externalIds] } },
        });
        return rows.map(toSocialAccount);
      },
      async upsert(account) {
        const changes = {
          connectionId: account.connectionId,
          type: account.type,
          name: account.name,
          handle: account.handle,
          avatarUrl: account.avatarUrl,
          accessTokenSealed: account.accessTokenSealed ? bytesOf(account.accessTokenSealed) : null,
          connectedById: account.connectedById,
        };
        await tx.socialAccount.upsert({
          where: {
            workspaceId_platform_externalId: {
              workspaceId: account.workspaceId,
              platform: account.platform,
              externalId: account.externalId,
            },
          },
          create: {
            id: account.id,
            workspaceId: account.workspaceId,
            platform: account.platform,
            externalId: account.externalId,
            ...changes,
          },
          update: { ...changes, disconnectedAt: null, ...bump },
        });
      },
      async disconnect(workspaceId, accountId, at) {
        const { count } = await tx.socialAccount.updateMany({
          where: { id: accountId, workspaceId, disconnectedAt: null },
          data: { disconnectedAt: at, accessTokenSealed: null, ...bump },
        });
        return count === 1;
      },
      connectedCount(workspaceId, connectionId) {
        return tx.socialAccount.count({ where: { workspaceId, connectionId, disconnectedAt: null } });
      },
    },

    audit: prismaAuditTrail(tx, scope.userId, origin),
  };
}
