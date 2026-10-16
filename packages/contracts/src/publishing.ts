import { z } from 'zod';

import { variantSchema, variantStatusSchema } from './content';
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
