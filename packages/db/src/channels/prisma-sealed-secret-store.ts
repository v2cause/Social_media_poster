import type { SealedSecretColumn, SealedSecretOwner, SealedSecretRow, SealedSecretStore } from '@smp/core';

import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The sealed columns of all workspaces for the re-wrap job (guide step 4.2). A cross-tenant scan,
// so it runs on the system client inside a system scope. A write only lands when the column
// still holds the bytes that were read, and it leaves the version of the row alone, so a token
// refresh at the same time keeps its result (see RewrapSecrets).

const CONNECTION_COLUMNS = {
  accessToken: 'accessTokenSealed',
  refreshToken: 'refreshTokenSealed',
  session: 'sessionSealed',
} as const satisfies Record<SealedSecretColumn, string>;

/** Copies into a buffer of its own, as Prisma expects for Bytes. */
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

function secretsOf(
  columns: Partial<Record<SealedSecretColumn, Uint8Array | null>>,
): SealedSecretRow['secrets'] {
  const secrets: SealedSecretRow['secrets'] = {};
  for (const [column, value] of Object.entries(columns) as [SealedSecretColumn, Uint8Array | null][]) {
    if (value) {
      secrets[column] = value;
    }
  }
  return secrets;
}

export class PrismaSealedSecretStore implements SealedSecretStore {
  constructor(private readonly system: SystemPrismaClient) {}

  list(owner: SealedSecretOwner, afterId: string | null, limit: number): Promise<SealedSecretRow[]> {
    const after = afterId === null ? {} : { id: { gt: afterId } };
    return runInSystemScope(async () => {
      if (owner === 'account') {
        const accounts = await this.system.socialAccount.findMany({
          where: { ...after, accessTokenSealed: { not: null } },
          orderBy: { id: 'asc' },
          take: limit,
          select: { id: true, workspaceId: true, accessTokenSealed: true },
        });
        return accounts.map((account) => ({
          id: account.id,
          workspaceId: account.workspaceId,
          secrets: secretsOf({ accessToken: account.accessTokenSealed }),
        }));
      }
      const connections = await this.system.socialConnection.findMany({
        where: {
          ...after,
          OR: [
            { accessTokenSealed: { not: null } },
            { refreshTokenSealed: { not: null } },
            { sessionSealed: { not: null } },
          ],
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: {
          id: true,
          workspaceId: true,
          accessTokenSealed: true,
          refreshTokenSealed: true,
          sessionSealed: true,
        },
      });
      return connections.map((connection) => ({
        id: connection.id,
        workspaceId: connection.workspaceId,
        secrets: secretsOf({
          accessToken: connection.accessTokenSealed,
          refreshToken: connection.refreshTokenSealed,
          session: connection.sessionSealed,
        }),
      }));
    });
  }

  replace(
    owner: SealedSecretOwner,
    id: string,
    column: SealedSecretColumn,
    previous: Uint8Array,
    next: Uint8Array,
  ): Promise<boolean> {
    return runInSystemScope(async () => {
      if (owner === 'account') {
        if (column !== 'accessToken') {
          return false;
        }
        const { count } = await this.system.socialAccount.updateMany({
          where: { id, accessTokenSealed: { equals: bytes(previous) } },
          data: { accessTokenSealed: bytes(next) },
        });
        return count === 1;
      }
      const field = CONNECTION_COLUMNS[column];
      const { count } = await this.system.socialConnection.updateMany({
        where: { id, [field]: { equals: bytes(previous) } },
        data: { [field]: bytes(next) },
      });
      return count === 1;
    });
  }
}
