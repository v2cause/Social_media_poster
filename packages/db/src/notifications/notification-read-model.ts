import { DEFAULT_CHANNELS, NOTIFICATION_TYPES, type NotificationPreference } from '@smp/core';
import { z } from 'zod';

import { InvalidCursorError } from '../audit/audit-log-read-model';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { withTenantTx, type TenantTransaction } from '../tenant-context';

// The notifications of the signed-in user, newest first, and the settings of their channels
// (guide step 4.9). Everything is read as the user: row-level security shows their own
// notifications and the workspaces they may open, and only notifications of those workspaces
// appear, so every link leads somewhere. The cursor is created_at plus id of the last entry.

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

export interface NotificationFilter {
  unreadOnly: boolean;
  cursor?: string;
  limit: number;
}

export interface NotificationView {
  id: string;
  type: string;
  /** NotificationContent as it was written; the API checks it against its contract. */
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
  workspace: { slug: string; name: string };
}

/** The workspaces the user may open, by id. */
async function visibleWorkspaces(
  tx: TenantTransaction,
  userId: string,
): Promise<Map<string, { slug: string; name: string }>> {
  const memberships = await tx.membership.findMany({ where: { userId }, select: { organizationId: true } });
  const workspaces = await tx.workspace.findMany({
    where: { organizationId: { in: memberships.map((membership) => membership.organizationId) } },
    select: { id: true, slug: true, name: true },
  });
  return new Map(
    workspaces.map((workspace) => [workspace.id, { slug: workspace.slug, name: workspace.name }]),
  );
}

export class NotificationReadModel {
  constructor(private readonly base: PrismaClient) {}

  list(
    userId: string,
    filter: NotificationFilter,
  ): Promise<{ items: NotificationView[]; nextCursor: string | null; unread: number }> {
    const after = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    return withTenantTx(this.base, { userId }, async (tx) => {
      const workspaces = await visibleWorkspaces(tx, userId);
      const visible: Prisma.NotificationWhereInput = { userId, workspaceId: { in: [...workspaces.keys()] } };
      const rows = await tx.notification.findMany({
        where: {
          ...visible,
          ...(filter.unreadOnly ? { readAt: null } : {}),
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
      const unread = await tx.notification.count({ where: { ...visible, readAt: null } });
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      return {
        items: page.flatMap((row) => {
          const workspace = row.workspaceId ? workspaces.get(row.workspaceId) : undefined;
          return workspace
            ? [
                {
                  id: row.id,
                  type: row.type,
                  payload: row.payload,
                  readAt: row.readAt,
                  createdAt: row.createdAt,
                  workspace,
                },
              ]
            : [];
        }),
        nextCursor:
          rows.length > filter.limit && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
        unread,
      };
    });
  }

  /** The unread notifications of the user, for the badge of the bell. */
  unreadCount(userId: string): Promise<number> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const workspaces = await visibleWorkspaces(tx, userId);
      return tx.notification.count({
        where: { userId, workspaceId: { in: [...workspaces.keys()] }, readAt: null },
      });
    });
  }

  /** The settings of every type; without one of the user, both channels are on. */
  preferences(userId: string): Promise<NotificationPreference[]> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const rows = await tx.notificationPreference.findMany({
        where: { userId },
        select: { type: true, channel: true, enabled: true },
      });
      const enabled = (type: string, channel: 'IN_APP' | 'EMAIL', fallback: boolean): boolean =>
        rows.find((row) => row.type === type && row.channel === channel)?.enabled ?? fallback;
      return NOTIFICATION_TYPES.map((type) => ({
        type,
        inApp: enabled(type, 'IN_APP', DEFAULT_CHANNELS.inApp),
        email: enabled(type, 'EMAIL', DEFAULT_CHANNELS.email),
      }));
    });
  }
}
