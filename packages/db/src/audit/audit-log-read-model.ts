import { DomainError } from '@smp/core';
import { z } from 'zod';

import type { PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';

// The audit log of an organization, newest first (guide step 1.7). The cursor is the position of
// the last entry of a page: created_at plus id, because several entries share a timestamp when
// one transaction writes them.

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';
  readonly kind = 'invalid';
  constructor() {
    super('The cursor is not valid.');
  }
}

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
type Cursor = z.infer<typeof cursorSchema>;

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new InvalidCursorError();
  }
}

const metadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
);

export interface AuditLogFilter {
  action?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface AuditLogEntryView {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  workspaceId: string | null;
  actor: { id: string; name: string } | null;
  metadata: z.infer<typeof metadataSchema> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export class AuditLogReadModel {
  constructor(private readonly base: PrismaClient) {}

  list(
    scope: { userId: string; organizationId: string },
    filter: AuditLogFilter,
  ): Promise<{ entries: AuditLogEntryView[]; nextCursor: string | null }> {
    const after = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    return withTenantTx(this.base, scope, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: {
          organizationId: scope.organizationId,
          action: filter.action,
          actorUserId: filter.actorUserId,
          createdAt: { gte: filter.from, lte: filter.to },
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
        take: filter.limit + 1,
      });
      const page = rows.slice(0, filter.limit);
      const actorIds = [...new Set(page.flatMap((row) => (row.actorUserId ? [row.actorUserId] : [])))];
      const actors = await tx.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      });
      const names = new Map(actors.map((actor) => [actor.id, actor.name]));
      const last = page.at(-1);

      return {
        entries: page.map((row) => ({
          id: row.id,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          workspaceId: row.workspaceId,
          actor: row.actorUserId ? { id: row.actorUserId, name: names.get(row.actorUserId) ?? '' } : null,
          metadata: row.metadata === null ? null : metadataSchema.parse(row.metadata),
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          createdAt: row.createdAt,
        })),
        nextCursor:
          rows.length > filter.limit && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      };
    });
  }
}
