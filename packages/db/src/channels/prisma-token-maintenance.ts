import type {
  ExpiringConnection,
  ExpiringConnectionScanner,
  TokenMaintenanceScope,
  TokenMaintenanceStore,
  TokenMaintenanceUnitOfWork,
} from '@smp/core';

import type { PrismaClient } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';
import { withTenantTx, type TenantTransaction } from '../tenant-context';
import { bytesOf, toSocialConnection } from './mappers';
import { markNeedsReauth } from './reauth';

// The token monitor and the token refresh on PostgreSQL (guide step 4.9). The scan runs across
// all workspaces as app_system; every change runs as app_user in the tenant of its connection,
// in one transaction with its outbox event.

/** SocialAccount.settings as an object; anything else counts as no settings. */
const settingsOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};

export function createPrismaTokenMaintenanceStore(tx: TenantTransaction): TokenMaintenanceStore {
  return {
    connections: {
      async find(workspaceId, connectionId) {
        const row = await tx.socialConnection.findFirst({ where: { id: connectionId, workspaceId } });
        return row ? toSocialConnection(row) : null;
      },
      async storeRefresh(workspaceId, connectionId, version, tokens) {
        const { count } = await tx.socialConnection.updateMany({
          where: { id: connectionId, workspaceId, version },
          data: {
            accessTokenSealed: bytesOf(tokens.accessTokenSealed),
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenSealed:
              tokens.refreshTokenSealed === null ? null : bytesOf(tokens.refreshTokenSealed),
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            scopes: tokens.scopes,
            lastRefreshedAt: tokens.refreshedAt,
            version: { increment: 1 },
          },
        });
        return count === 1;
      },
      async expiryNoticeOf(workspaceId, connectionId) {
        const row = await tx.socialConnection.findFirst({
          where: { id: connectionId, workspaceId },
          select: { expiryNoticeDays: true },
        });
        return row?.expiryNoticeDays ?? null;
      },
      async setExpiryStatus(workspaceId, connectionId, status, resetNotices) {
        await tx.socialConnection.updateMany({
          where: { id: connectionId, workspaceId, status: { in: ['ACTIVE', 'EXPIRING'] } },
          data: {
            status,
            ...(resetNotices ? { expiryNoticeDays: null } : {}),
            version: { increment: 1 },
          },
        });
      },
      async noteExpiryNotice(workspaceId, connectionId, stage, previous) {
        const { count } = await tx.socialConnection.updateMany({
          where: { id: connectionId, workspaceId, status: 'EXPIRING', expiryNoticeDays: previous },
          data: { expiryNoticeDays: stage },
        });
        return count === 1;
      },
      markNeedsReauth: (workspaceId, connectionId, reason) =>
        markNeedsReauth(tx, workspaceId, connectionId, reason),
    },
    accounts: {
      async anyConnected(workspaceId, connectionId) {
        const row = await tx.socialAccount.findFirst({
          where: { workspaceId, connectionId, disconnectedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        return row
          ? {
              account: {
                id: row.id,
                workspaceId: row.workspaceId,
                connectionId: row.connectionId,
                platform: row.platform,
                type: row.type,
                externalId: row.externalId,
                name: row.name,
                handle: row.handle,
                settings: settingsOf(row.settings),
              },
              accessTokenSealed: row.accessTokenSealed,
            }
          : null;
      },
    },
    outbox: {
      async add(workspaceId, event) {
        await tx.outboxEvent.create({ data: { workspaceId, type: event.type, payload: event.payload } });
      },
    },
  };
}

/** TokenMaintenanceUnitOfWork on PostgreSQL: one transaction per change, in the tenant of the job. */
export class PrismaTokenMaintenanceUnitOfWork implements TokenMaintenanceUnitOfWork {
  constructor(private readonly base: PrismaClient) {}

  run<T>(scope: TokenMaintenanceScope, work: (store: TokenMaintenanceStore) => Promise<T>): Promise<T> {
    return withTenantTx(
      this.base,
      { organizationId: scope.organizationId, workspaceId: scope.workspaceId },
      (tx) => work(createPrismaTokenMaintenanceStore(tx)),
    );
  }
}

interface ExpiringRow {
  id: string;
  workspace_id: string;
  organization_id: string;
  status: 'ACTIVE' | 'EXPIRING';
  method: ExpiringConnection['method'];
  access_expires_at: Date;
  expiry_notice_days: number | null;
}

/**
 * The scan of tick.tokens across all workspaces: usable connections whose access, as the user
 * sees it (the refresh token when there is one, else the access token), runs out until then.
 */
export class PrismaExpiringConnectionScanner implements ExpiringConnectionScanner {
  constructor(private readonly system: SystemPrismaClient) {}

  async expiring(until: Date, limit: number): Promise<ExpiringConnection[]> {
    const rows = await runInSystemScope(
      () => this.system.$queryRaw<ExpiringRow[]>`
        SELECT c.id, c.workspace_id, w.organization_id, c.status::text AS status, c.method::text AS method,
               c.expiry_notice_days, x.access_expires_at
          FROM social_connection c
          JOIN workspace w ON w.id = c.workspace_id
          CROSS JOIN LATERAL (
            SELECT CASE WHEN c.refresh_token_sealed IS NOT NULL THEN c.refresh_token_expires_at
                        ELSE c.access_token_expires_at END AS access_expires_at
          ) x
         WHERE c.status IN ('ACTIVE', 'EXPIRING')
           AND x.access_expires_at IS NOT NULL
           AND x.access_expires_at <= ${until}
         ORDER BY x.access_expires_at
         LIMIT ${limit}`,
    );
    return rows.map((row) => ({
      connectionId: row.id,
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
      status: row.status,
      method: row.method,
      accessExpiresAt: row.access_expires_at,
      expiryNoticeDays: row.expiry_notice_days,
    }));
  }
}
