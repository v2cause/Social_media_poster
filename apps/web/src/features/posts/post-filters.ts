import type { PublishingListParams } from '@smp/api-client';
import { VARIANT_STATUSES, type VariantListItemDto } from '@smp/contracts';
import { PLATFORMS } from '@smp/platform-rules';
import { z } from 'zod';

import { CANCELABLE_STATUSES } from '@/features/publishing/statuses';
import { addDays, startOfLocalDay } from '@/features/publishing/zoned-time';

// The filters of the post list (guide step 4.11) and what a selection of rows allows. The filters
// live in the query string; each one is empty when it is missing or invalid. The period is a span
// of local days in the time zone of the workspace; the API takes its instants.

const none = z.literal('');

export const postFiltersSchema = z.object({
  status: z.union([z.enum(VARIANT_STATUSES), none]).catch(''),
  platform: z.union([z.enum(PLATFORMS), none]).catch(''),
  accountId: z.union([z.uuid(), none]).catch(''),
  /** First and last planned day, YYYY-MM-DD. */
  from: z.union([z.iso.date(), none]).catch(''),
  to: z.union([z.iso.date(), none]).catch(''),
});
export type PostFilters = z.infer<typeof postFiltersSchema>;

export const NO_FILTERS: PostFilters = { status: '', platform: '', accountId: '', from: '', to: '' };

/** True when the period ends before it starts. */
export const isInvertedPeriod = (filters: PostFilters): boolean =>
  filters.from !== '' && filters.to !== '' && filters.to < filters.from;

export const PAGE_SIZE = 50;

/** The query of GET /api/w/:ws/variants for the filters, last changed first. */
export function listParamsOf(filters: PostFilters, timeZone: string): PublishingListParams {
  return {
    order: 'recent',
    limit: PAGE_SIZE,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.from ? { from: startOfLocalDay(filters.from, timeZone).toISOString() } : {}),
    // The last day counts in full: the period ends where the next day starts.
    ...(filters.to ? { to: startOfLocalDay(addDays(filters.to, 1), timeZone).toISOString() } : {}),
  };
}

/** What the selected rows allow: the plans to cancel and the posts to delete. */
export function selectionOf(items: readonly VariantListItemDto[], selected: ReadonlySet<string>) {
  const rows = items.filter((item) => selected.has(item.id));
  return {
    cancelable: rows.filter((item) => CANCELABLE_STATUSES.includes(item.status)),
    postIds: [...new Set(rows.map((item) => item.postId))],
  };
}
