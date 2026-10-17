import { z } from 'zod';

import { platformSchema } from './content';

// The notifications of the signed-in user and the settings of their channels (guide step 4.9).
// A notification belongs to one user and names its workspace, so the bell links into it. Only
// notifications of the workspaces the user may still open appear.

const id = z.uuid();
const timestamp = z.iso.datetime();

export const NOTIFICATION_TYPES = [
  'token-expiring',
  'reauth-required',
  'publish-failed',
  'needs-attention',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationTypeDto = z.infer<typeof notificationTypeSchema>;

const subject = { platform: platformSchema, accounts: z.array(z.string()) };
const post = { postId: id, variantId: id, preview: z.string(), failureCode: z.string() };

/** What a notification shows, by type. */
export const notificationContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('token-expiring'),
    connectionId: id,
    ...subject,
    daysLeft: z.number().int(),
    expiresAt: timestamp,
  }),
  z.object({
    type: z.literal('reauth-required'),
    connectionId: id,
    ...subject,
    reason: z.string(),
    scheduledVariants: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('publish-failed'), ...subject, ...post }),
  z.object({ type: z.literal('needs-attention'), ...subject, ...post }),
]);
export type NotificationContentDto = z.infer<typeof notificationContentSchema>;

export const notificationSchema = z.object({
  id,
  createdAt: timestamp,
  readAt: timestamp.nullable(),
  workspace: z.object({ slug: z.string(), name: z.string() }),
  content: notificationContentSchema,
});
export type NotificationDto = z.infer<typeof notificationSchema>;

/** GET /api/me/notifications: newest first, cursor pagination, optionally the unread ones only. */
export const notificationQuerySchema = z.object({
  unread: z.stringbool().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  /** All unread notifications of the user, for the badge of the bell. */
  unread: z.number().int().nonnegative(),
});
export type NotificationPageDto = z.infer<typeof notificationPageSchema>;

export const unreadNotificationsSchema = z.object({ unread: z.number().int().nonnegative() });
export type UnreadNotificationsDto = z.infer<typeof unreadNotificationsSchema>;

export const markNotificationsReadSchema = z.object({ ids: z.array(id).min(1).max(100) });
export type MarkNotificationsReadRequest = z.input<typeof markNotificationsReadSchema>;

export const markedNotificationsSchema = z.object({ marked: z.number().int().nonnegative() });
export type MarkedNotificationsDto = z.infer<typeof markedNotificationsSchema>;

/** How a type of notification arrives: in the app, by email, both or neither. */
export const notificationPreferenceSchema = z.object({
  type: notificationTypeSchema,
  inApp: z.boolean(),
  email: z.boolean(),
});
export type NotificationPreferenceDto = z.infer<typeof notificationPreferenceSchema>;

/** The settings of every type, or the ones to change; each type once. */
export const notificationPreferencesSchema = z.object({
  preferences: z
    .array(notificationPreferenceSchema)
    .max(NOTIFICATION_TYPES.length)
    .refine((items) => new Set(items.map((item) => item.type)).size === items.length, {
      message: 'duplicate_type',
    }),
});
export type NotificationPreferencesDto = z.infer<typeof notificationPreferencesSchema>;
