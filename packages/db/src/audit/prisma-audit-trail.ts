import { assertSafeAuditMetadata, type AuditEntry, type AuditTrail } from '@smp/core';

import { Prisma } from '../generated/prisma/client';
import type { TenantTransaction } from '../tenant-context';

/** Where a change came from, for the audit log. Filled from the request context (step 1.7). */
export interface RequestOrigin {
  ipAddress?: string;
  userAgent?: string;
}

/** Writes audit entries in the transaction of the change, with the actor of the scope. */
export const prismaAuditTrail = (
  tx: TenantTransaction,
  actorUserId: string | undefined,
  origin: RequestOrigin,
): AuditTrail => ({
  async record(entry: AuditEntry) {
    assertSafeAuditMetadata(entry.metadata);
    await tx.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        workspaceId: entry.workspaceId ?? null,
        actorUserId: actorUserId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? Prisma.DbNull,
        ipAddress: origin.ipAddress ?? null,
        userAgent: origin.userAgent ?? null,
      },
    });
  },
});
