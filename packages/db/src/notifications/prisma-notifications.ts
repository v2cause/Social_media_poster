import {
  DEFAULT_CHANNELS,
  previewOf,
  type InAppNotification,
  type NotificationChannels,
  type NotificationContent,
  type NotificationDirectory,
  type NotificationInbox,
  type NotificationPreference,
  type NotificationRecipient,
  type NotificationRequest,
  type NotificationScope,
  type NotificationType,
  type NotificationWorkspace,
  type UserNotifications,
} from '@smp/core';

import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { withTenantTx, type TenantTransaction } from '../tenant-context';

// The notifications of events on PostgreSQL (guide step 4.9, ADR 0025). The directory reads as
// app_user in the tenant of the event: the connection or variant, its accounts, the workspace and
// the members to tell. The inbox writes as each recipient, and the signed-in user changes their
// own, because notifications and their settings are per user (architecture 6.3).

/** A plain JSON copy for the payload column. */
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const userSelect = { id: true, email: true, name: true, locale: true } as const;

const recipientOf = (user: {
  id: string;
  email: string;
  name: string;
  locale: string;
}): NotificationRecipient => ({
  userId: user.id,
  email: user.email,
  name: user.name.trim().length > 0 ? user.name : null,
  // The app speaks German and English; German is the default (guide step 1.10).
  locale: user.locale === 'en' ? 'en' : 'de',
});

async function workspaceOf(
  tx: TenantTransaction,
  workspaceId: string,
): Promise<NotificationWorkspace | null> {
  const row = await tx.workspace.findFirst({
    where: { id: workspaceId },
    select: { id: true, slug: true, name: true, timezone: true },
  });
  return row ? { id: row.id, slug: row.slug, name: row.name, timeZone: row.timezone } : null;
}

async function contentOf(
  tx: TenantTransaction,
  workspaceId: string,
  request: NotificationRequest,
): Promise<NotificationContent | null> {
  switch (request.type) {
    case 'token-expiring':
    case 'reauth-required': {
      const connection = await tx.socialConnection.findFirst({
        where: { id: request.connectionId, workspaceId },
        select: {
          platform: true,
          displayName: true,
          accounts: { where: { disconnectedAt: null }, select: { name: true }, orderBy: { name: 'asc' } },
        },
      });
      if (!connection) {
        return null;
      }
      const accounts =
        connection.accounts.length > 0
          ? connection.accounts.map((account) => account.name)
          : [connection.displayName];
      return request.type === 'token-expiring'
        ? { ...request, platform: connection.platform, accounts }
        : { ...request, platform: connection.platform, accounts };
    }
    case 'publish-failed':
    case 'needs-attention': {
      const variant = await tx.postVariant.findFirst({
        where: { id: request.variantId, workspaceId },
        select: { postId: true, platform: true, text: true, socialAccount: { select: { name: true } } },
      });
      if (!variant) {
        return null;
      }
      return {
        type: request.type,
        postId: variant.postId,
        variantId: request.variantId,
        platform: variant.platform,
        accounts: variant.socialAccount ? [variant.socialAccount.name] : [],
        preview: previewOf(variant.text),
        failureCode: request.failureCode,
      };
    }
  }
}

export class PrismaNotificationDirectory implements NotificationDirectory {
  constructor(private readonly base: PrismaClient) {}

  describe(
    scope: NotificationScope,
    request: NotificationRequest,
  ): Promise<{ workspace: NotificationWorkspace; content: NotificationContent } | null> {
    return withTenantTx(this.base, scope, async (tx) => {
      const workspace = await workspaceOf(tx, scope.workspaceId);
      const content = workspace ? await contentOf(tx, scope.workspaceId, request) : null;
      return workspace && content ? { workspace, content } : null;
    });
  }

  channelManagers(scope: NotificationScope): Promise<NotificationRecipient[]> {
    return withTenantTx(this.base, scope, async (tx) => {
      const members = await tx.membership.findMany({
        where: { organizationId: scope.organizationId, role: { in: ['OWNER', 'ADMIN'] } },
        orderBy: { createdAt: 'asc' },
        select: { user: { select: userSelect } },
      });
      return members.map((member) => recipientOf(member.user));
    });
  }

  postAuthor(scope: NotificationScope, postId: string): Promise<NotificationRecipient[]> {
    return withTenantTx(this.base, scope, async (tx) => {
      const post = await tx.post.findFirst({
        where: { id: postId, workspaceId: scope.workspaceId },
        select: { createdById: true },
      });
      if (!post?.createdById) {
        return [];
      }
      const membership = await tx.membership.findFirst({
        where: { organizationId: scope.organizationId, userId: post.createdById },
        select: { role: true, workspaces: { select: { workspaceId: true } }, user: { select: userSelect } },
      });
      // Owners and admins see every workspace; others all of them unless they are restricted.
      const sees =
        membership &&
        (membership.role === 'OWNER' ||
          membership.role === 'ADMIN' ||
          membership.workspaces.length === 0 ||
          membership.workspaces.some((entry) => entry.workspaceId === scope.workspaceId));
      return sees ? [recipientOf(membership.user)] : [];
    });
  }
}

export class PrismaNotificationInbox implements NotificationInbox {
  constructor(private readonly base: PrismaClient) {}

  channelsOf(userId: string, type: NotificationType): Promise<NotificationChannels> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const settings = await tx.notificationPreference.findMany({
        where: { userId, type },
        select: { channel: true, enabled: true },
      });
      const enabled = (channel: 'IN_APP' | 'EMAIL', fallback: boolean): boolean =>
        settings.find((setting) => setting.channel === channel)?.enabled ?? fallback;
      return {
        inApp: enabled('IN_APP', DEFAULT_CHANNELS.inApp),
        email: enabled('EMAIL', DEFAULT_CHANNELS.email),
      };
    });
  }

  addOnce(userId: string, notification: InAppNotification): Promise<string | null> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const [created] = await tx.notification.createManyAndReturn({
        data: [
          {
            userId,
            organizationId: notification.organizationId,
            workspaceId: notification.workspaceId,
            eventId: notification.eventId,
            type: notification.content.type,
            payload: json(notification.content),
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      return created?.id ?? null;
    });
  }
}

export class PrismaUserNotifications implements UserNotifications {
  constructor(private readonly base: PrismaClient) {}

  markRead(userId: string, ids: readonly string[] | 'all', at: Date): Promise<number> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: [...ids] } }) },
        data: { readAt: at },
      });
      return count;
    });
  }

  savePreferences(userId: string, preferences: readonly NotificationPreference[]): Promise<void> {
    return withTenantTx(this.base, { userId }, async (tx) => {
      for (const preference of preferences) {
        for (const [channel, enabled] of [
          ['IN_APP', preference.inApp],
          ['EMAIL', preference.email],
        ] as const) {
          await tx.notificationPreference.upsert({
            where: { userId_type_channel: { userId, type: preference.type, channel } },
            create: { userId, type: preference.type, channel, enabled },
            update: { enabled },
          });
        }
      }
    });
  }
}
