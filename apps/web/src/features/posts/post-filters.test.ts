import type { VariantListItemDto } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import { isInvertedPeriod, listParamsOf, NO_FILTERS, postFiltersSchema, selectionOf } from './post-filters';

const item = (id: string, postId: string, status: VariantListItemDto['status']): VariantListItemDto => ({
  id,
  postId,
  platform: 'LINKEDIN',
  status,
  version: 1,
  preview: '',
  account: null,
  scheduledAt: null,
  scheduledTimezone: null,
  publishedAt: null,
  externalUrl: null,
  failureCode: null,
  isDryRun: false,
  updatedAt: '2026-10-17T10:00:00.000Z',
});

describe('post list filters', () => {
  it('asks for every variant without filters and for whole local days with a period', () => {
    expect(listParamsOf(NO_FILTERS, 'Europe/Berlin')).toEqual({ order: 'recent', limit: 50 });
    expect(
      listParamsOf(
        { status: 'SCHEDULED', platform: 'X', accountId: 'a', from: '2026-10-24', to: '2026-10-25' },
        'Europe/Berlin',
      ),
    ).toEqual({
      order: 'recent',
      limit: 50,
      status: 'SCHEDULED',
      platform: 'X',
      accountId: 'a',
      from: '2026-10-23T22:00:00.000Z',
      // October 25 has 25 hours in Berlin; the period ends with it.
      to: '2026-10-25T23:00:00.000Z',
    });
    expect(isInvertedPeriod({ ...NO_FILTERS, from: '2026-10-25', to: '2026-10-24' })).toBe(true);
    expect(isInvertedPeriod({ ...NO_FILTERS, from: '2026-10-25', to: '2026-10-25' })).toBe(false);
  });

  it('reads the filters from the query string and drops what is not a valid filter', () => {
    expect(postFiltersSchema.parse({})).toEqual(NO_FILTERS);
    expect(
      postFiltersSchema.parse({
        status: 'SCHEDULED',
        platform: 'X',
        accountId: '01a14780-1bd2-706f-b18c-abd9e58dd5a1',
        from: '2026-10-24',
        to: '2026-10-25',
        page: '3',
      }),
    ).toEqual({
      status: 'SCHEDULED',
      platform: 'X',
      accountId: '01a14780-1bd2-706f-b18c-abd9e58dd5a1',
      from: '2026-10-24',
      to: '2026-10-25',
    });
    expect(
      postFiltersSchema.parse({
        status: 'LOST',
        platform: 'MYSPACE',
        accountId: 'x',
        from: '2026-13-45',
        to: 'soon',
      }),
    ).toEqual(NO_FILTERS);
  });

  it('cancels the plans among the selected rows and deletes their posts once each', () => {
    const items = [
      item('v1', 'p1', 'SCHEDULED'),
      item('v2', 'p1', 'PUBLISHED'),
      item('v3', 'p2', 'QUEUED'),
      item('v4', 'p3', 'DRAFT'),
    ];
    const selection = selectionOf(items, new Set(['v1', 'v2', 'v3']));
    expect(selection.cancelable.map((row) => row.id)).toEqual(['v1', 'v3']);
    expect(selection.postIds).toEqual(['p1', 'p2']);
  });
});
