import { describe, expect, it } from 'vitest';

import {
  analyticsBreakdownQuerySchema,
  analyticsFilterSchema,
  analyticsTimeseriesQuerySchema,
  analyticsTopPostsQuerySchema,
} from './analytics';

// Guide step 5.4: the filters of the analytics API: lists of platforms and accounts, a period of
// local days of at most 366 days, and the defaults of each view.

const account = '0192f5d4-0000-7000-8000-000000000001';

describe('analytics contracts', () => {
  it('reads lists of platforms and accounts and a period of local days', () => {
    expect(
      analyticsFilterSchema.parse({
        from: '2026-09-17',
        to: '2026-10-16',
        platform: 'LINKEDIN,X',
        accountId: account,
      }),
    ).toEqual({ from: '2026-09-17', to: '2026-10-16', platform: ['LINKEDIN', 'X'], accountId: [account] });
    expect(analyticsFilterSchema.parse({})).toEqual({});
    expect(() => analyticsFilterSchema.parse({ platform: 'MYSPACE' })).toThrow();
    expect(() => analyticsFilterSchema.parse({ accountId: 'x' })).toThrow();
  });

  it('refuses a period that ends before it starts or lasts more than 366 days', () => {
    expect(() => analyticsFilterSchema.parse({ from: '2026-10-16', to: '2026-10-15' })).toThrow(
      /from_after_to/,
    );
    expect(() => analyticsFilterSchema.parse({ from: '2025-01-01', to: '2026-01-02' })).toThrow(
      /period_too_long/,
    );
    expect(analyticsFilterSchema.parse({ from: '2025-01-01', to: '2026-01-01' })).toMatchObject({
      to: '2026-01-01',
    });
  });

  it('fills in the defaults of the time series, the top posts and the breakdown', () => {
    expect(analyticsTimeseriesQuerySchema.parse({})).toEqual({
      metric: 'impressions',
      granularity: 'day',
      groupBy: 'platform',
    });
    expect(analyticsTopPostsQuerySchema.parse({ limit: '5' })).toEqual({
      sort: 'engagements',
      limit: 5,
      minImpressions: 100,
    });
    expect(() => analyticsBreakdownQuerySchema.parse({})).toThrow();
    expect(analyticsBreakdownQuerySchema.parse({ by: 'weekday' })).toEqual({ by: 'weekday' });
  });
});
