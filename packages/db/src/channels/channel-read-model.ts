import {
  accessExpiryOf,
  type ConnectionMethod,
  type ConnectionStatus,
  type SocialAccountType,
} from '@smp/core';

import type { Platform, PrismaClient } from '../generated/prisma/client';
import { withTenantTx, type WorkspaceRef } from '../tenant-context';

// The read side of the channels context (guide step 4.5): the connected accounts of a workspace
// with the state of their connection and, for X, what its paid calls cost so far (guide step
// 4.11). Tokens are never read here.

export interface SocialAccountView {
  id: string;
  connectionId: string;
  platform: Platform;
  method: ConnectionMethod;
  type: SocialAccountType;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  status: ConnectionStatus;
  statusReason: string | null;
  /** When the user has to grant access again; null when the access does not expire. */
  accessExpiresAt: Date | null;
  grantedScopes: string[];
  connectedAt: Date;
  /** The paid calls of the account so far in micro-USD; null on platforms without call costs. */
  costMicros: number | null;
}

/** The platforms whose API calls cost money and are kept in ApiCostRecord. */
const PAID_PLATFORMS: readonly Platform[] = ['X'];

export class ChannelReadModel {
  constructor(private readonly base: PrismaClient) {}

  /** The connected accounts of the workspace, by platform and name. */
  accounts(ref: WorkspaceRef): Promise<SocialAccountView[]> {
    return withTenantTx(this.base, ref, async (tx) => {
      const rows = await tx.socialAccount.findMany({
        where: { workspaceId: ref.workspaceId, disconnectedAt: null },
        select: {
          id: true,
          connectionId: true,
          platform: true,
          type: true,
          name: true,
          handle: true,
          avatarUrl: true,
          createdAt: true,
          connection: {
            select: {
              method: true,
              status: true,
              statusReason: true,
              accessTokenExpiresAt: true,
              refreshTokenExpiresAt: true,
              // Only whether there is one; the bytes are not passed on.
              refreshTokenSealed: true,
              scopes: true,
            },
          },
        },
        orderBy: [{ platform: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      });
      const paid = rows.filter((row) => PAID_PLATFORMS.includes(row.platform)).map((row) => row.id);
      const costs =
        paid.length === 0
          ? []
          : await tx.apiCostRecord.groupBy({
              by: ['socialAccountId'],
              where: { organizationId: ref.organizationId, socialAccountId: { in: paid } },
              _sum: { costMicros: true },
            });
      const costOf = new Map(costs.map((cost) => [cost.socialAccountId, Number(cost._sum.costMicros ?? 0)]));
      return rows.map(({ connection, createdAt, ...account }) => ({
        ...account,
        method: connection.method,
        status: connection.status,
        statusReason: connection.statusReason,
        accessExpiresAt: accessExpiryOf({
          hasRefreshToken: connection.refreshTokenSealed !== null,
          accessTokenExpiresAt: connection.accessTokenExpiresAt,
          refreshTokenExpiresAt: connection.refreshTokenExpiresAt,
        }),
        grantedScopes: connection.scopes,
        connectedAt: createdAt,
        costMicros: PAID_PLATFORMS.includes(account.platform) ? (costOf.get(account.id) ?? 0) : null,
      }));
    });
  }
}
