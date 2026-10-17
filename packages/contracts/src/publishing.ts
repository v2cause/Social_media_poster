import { z } from 'zod';

import { socialAccountTypeSchema } from './channels';
import { platformSchema, VARIANT_STATUSES, variantSchema, variantStatusSchema } from './content';
import { timezoneSchema } from './timezone';

// Requests and responses of planning and publishing (guide step 4.6, architecture 7). Times are
// local: a date and time as the user picked it, in an IANA time zone. The API turns them into
// UTC and answers 422 for a time in the past or in the gap of a change of the clocks.

const id = z.uuid();
/** Optimistic locking: the version the client last read (409 when it is stale). */
const version = z.number().int().min(0);

/** A local date and time to the minute, for example 2026-10-20T09:30. */
export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'invalid_local_date_time');

/** Hints that do not stop a plan. The UI translates them. */
export const SCHEDULE_WARNINGS = ['ACCESS_EXPIRES_BEFORE_PUBLISH', 'ACCOUNT_EXPIRING'] as const;
export const scheduleWarningSchema = z.enum(SCHEDULE_WARNINGS);

export const scheduleVariantSchema = z.object({
  version,
  localDateTime: localDateTimeSchema,
  timeZone: timezoneSchema,
  /** The account to publish to; without it the variant keeps its account. */
  socialAccountId: id.optional(),
});
export type ScheduleVariantRequest = z.input<typeof scheduleVariantSchema>;

export const cancelVariantSchema = z.object({ version });
export type CancelVariantRequest = z.input<typeof cancelVariantSchema>;

export const publishNowSchema = z.object({
  version,
  /** The time zone the calendar shows the post in. */
  timeZone: timezoneSchema,
  socialAccountId: id.optional(),
});
export type PublishNowRequest = z.input<typeof publishNowSchema>;

/** Without a local time the variant goes out now. */
export const retryVariantSchema = z.object({
  version,
  timeZone: timezoneSchema,
  localDateTime: localDateTimeSchema.optional(),
});
export type RetryVariantRequest = z.input<typeof retryVariantSchema>;

/** Check again, post anyway, or discard a variant whose publish ended unclear. */
export const NEEDS_ATTENTION_ACTIONS = ['recheck', 'publish_anyway', 'discard'] as const;
export const resolveVariantSchema = z.object({
  version,
  action: z.enum(NEEDS_ATTENTION_ACTIONS),
});
export type ResolveVariantRequest = z.input<typeof resolveVariantSchema>;

/** The variant after the change, with the hints of the plan. */
export const planResultSchema = z.object({
  variant: variantSchema,
  status: variantStatusSchema,
  warnings: z.array(scheduleWarningSchema),
});
export type PlanResultDto = z.infer<typeof planResultSchema>;

// --- The variants of a workspace (guide step 4.11) ----------------------------------------------

/** recent: last changed first, for the post list; schedule: by planned time, for the calendar. */
export const VARIANT_LIST_ORDERS = ['recent', 'schedule'] as const;

const timestamp = z.iso.datetime();

/** GET /api/w/:ws/variants: filters of the calendar, the post list and the dashboard. */
export const variantListQuerySchema = z
  .object({
    /** One or more statuses, comma-separated; without it every status but DELETED. */
    status: z
      .string()
      .max(200)
      .transform((value) => value.split(',').filter((part) => part.length > 0))
      .pipe(z.array(z.enum(VARIANT_STATUSES)).min(1).max(VARIANT_STATUSES.length))
      .optional(),
    platform: platformSchema.optional(),
    accountId: id.optional(),
    /** The planned time, from (inclusive) to (exclusive). */
    from: timestamp.optional(),
    to: timestamp.optional(),
    order: z.enum(VARIANT_LIST_ORDERS).default('recent'),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .refine((query) => !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to), {
    message: 'from_after_to',
  });
export type VariantListQuery = z.input<typeof variantListQuerySchema>;

export const variantListItemSchema = z.object({
  id,
  postId: id,
  platform: platformSchema,
  status: variantStatusSchema,
  version,
  /** The beginning of the text on one line. */
  preview: z.string(),
  account: z
    .object({ id, name: z.string(), handle: z.string().nullable(), type: socialAccountTypeSchema })
    .nullable(),
  scheduledAt: timestamp.nullable(),
  scheduledTimezone: z.string().nullable(),
  publishedAt: timestamp.nullable(),
  externalUrl: z.string().nullable(),
  failureCode: z.string().nullable(),
  isDryRun: z.boolean(),
  updatedAt: timestamp,
});
export type VariantListItemDto = z.infer<typeof variantListItemSchema>;

export const variantPageSchema = z.object({
  items: z.array(variantListItemSchema),
  nextCursor: z.string().nullable(),
});
export type VariantPageDto = z.infer<typeof variantPageSchema>;
