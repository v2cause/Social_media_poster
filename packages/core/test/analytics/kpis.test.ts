import { describe, expect, it } from 'vitest';

import {
  AnalyticsHistoryExceededError,
  analyticsPeriodOf,
  breakdownOf,
  bucketOf,
  dailyEngagementRateOf,
  daysBetween,
  engagementRateOf,
  fixedAnalyticsHistory,
  followerGrowthOf,
  followersByDay,
  reachOf,
  resolveAnalyticsPeriod,
  seriesOf,
  sumOf,
  type BreakdownPost,
  type DailyMetrics,
} from '../../src';

// Guide step 5.4: the KPIs from the rollup. Missing metrics stay null, the reach of an account
// wins over the sum of its post reaches, rates take impressions, else views, else reach, and the
// period is limited by the history of the plan.

const row = (accountId: string, day: string, values: Partial<DailyMetrics> = {}): DailyMetrics => ({
  accountId,
  platform: 'LINKEDIN',
  day,
  impressions: null,
  postReach: null,
  views: null,
  likes: null,
  comments: null,
  shares: null,
  clicks: null,
  saves: null,
  engagements: null,
  postsPublished: 0,
  followers: null,
  accountReach: null,
  profileViews: null,
  ...values,
});

describe('analytics KPIs', () => {
  it('adds up reported values and keeps nothing reported as null', () => {
    expect(sumOf([null, null])).toBeNull();
    expect(sumOf([null, 0])).toBe(0);
    expect(sumOf([3, null, -1])).toBe(2);
  });

  it('takes impressions, else views, else reach as the base of the rate', () => {
    expect(
      engagementRateOf([
        { engagements: 10, impressions: 200, views: null, reach: 150 },
        // Instagram: no impressions, views instead.
        { engagements: 30, impressions: null, views: 600, reach: 400 },
        // No base: left out, not counted as zero.
        { engagements: 5, impressions: null, views: null, reach: null },
      ]),
    ).toBe(40 / 800);
    expect(engagementRateOf([{ engagements: 3, impressions: 0, views: null, reach: null }])).toBeNull();
    expect(dailyEngagementRateOf([row('a', '2026-10-01', { engagements: 4, postReach: 40 })])).toBe(0.1);
  });

  it('prefers the reach of an account and names the basis', () => {
    const own = row('a', '2026-10-01', { accountReach: 1_000, postReach: 1_400 });
    const posts = row('b', '2026-10-01', { postReach: 300 });
    expect(reachOf([own])).toEqual({ value: 1_000, basis: 'account' });
    expect(reachOf([posts])).toEqual({ value: 300, basis: 'posts' });
    expect(reachOf([own, posts])).toEqual({ value: 1_300, basis: 'mixed' });
    expect(reachOf([row('c', '2026-10-01')])).toEqual({ value: null, basis: null });
  });

  it('measures the follower growth from the count before the period, or from its first count', () => {
    const rows = [
      row('a', '2026-10-01', { followers: 510 }),
      row('a', '2026-10-03', { followers: 525 }),
      row('b', '2026-10-02', { followers: 90 }),
      row('b', '2026-10-03', { followers: 88 }),
      row('c', '2026-10-02'),
    ];
    expect(followerGrowthOf(rows, new Map([['a', 500]]))).toBe(25 + -2);
    expect(followerGrowthOf([row('c', '2026-10-01')], new Map())).toBeNull();
  });

  it('carries the follower counts forward per account from day to day', () => {
    const rows = [row('a', '2026-10-02', { followers: 510 }), row('b', '2026-10-03', { followers: 90 })];
    expect(followersByDay(rows, daysBetween('2026-10-01', '2026-10-04'), new Map())).toEqual([
      null,
      510,
      600,
      600,
    ]);
    expect(followersByDay(rows, ['2026-10-01'], new Map([['a', 500]]))).toEqual([500]);
  });

  it('buckets days by day, by the Monday of the week and by month', () => {
    expect(bucketOf('2026-10-16', 'day')).toBe('2026-10-16');
    // October 16, 2026 is a Friday; October 12 the Monday before.
    expect(bucketOf('2026-10-16', 'week')).toBe('2026-10-12');
    expect(bucketOf('2026-10-12', 'week')).toBe('2026-10-12');
    expect(bucketOf('2026-10-18', 'week')).toBe('2026-10-12');
    expect(bucketOf('2026-10-16', 'month')).toBe('2026-10-01');
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('builds a series per bucket: sums, rates per bucket and the followers at its end', () => {
    const rows = [
      row('a', '2026-10-05', { impressions: 100, engagements: 5, followers: 500 }),
      row('a', '2026-10-06', { impressions: 50, engagements: 5 }),
      row('a', '2026-10-13', { impressions: null, postsPublished: 2, followers: 520 }),
    ];
    const days = daysBetween('2026-10-05', '2026-10-18');
    expect(seriesOf(rows, 'impressions', days, 'week', new Map())).toEqual({
      buckets: ['2026-10-05', '2026-10-12'],
      values: [150, null],
    });
    expect(seriesOf(rows, 'engagementRate', days, 'week', new Map()).values).toEqual([10 / 150, null]);
    expect(seriesOf(rows, 'postsPublished', days, 'week', new Map()).values).toEqual([0, 2]);
    expect(seriesOf(rows, 'followers', days, 'week', new Map()).values).toEqual([500, 520]);
  });

  it('takes the last 30 days without a choice and compares with the 30 days before', () => {
    expect(analyticsPeriodOf({}, '2026-10-16', 365)).toEqual({
      from: '2026-09-17',
      to: '2026-10-16',
      previous: { from: '2026-08-18', to: '2026-09-16' },
      historyFrom: '2025-10-17',
    });
    // The period before is cut where the history begins, or left out when it lies before it.
    // 90 days of history reach back to July 19.
    expect(analyticsPeriodOf({ from: '2026-07-19', to: '2026-10-16' }, '2026-10-16', 90).previous).toBeNull();
    expect(analyticsPeriodOf({ from: '2026-09-01', to: '2026-10-16' }, '2026-10-16', 90).previous).toEqual({
      from: '2026-07-19',
      to: '2026-08-31',
    });
    expect(analyticsPeriodOf({ from: '2026-10-20' }, '2026-10-16', 365)).toMatchObject({
      from: '2026-10-20',
      to: '2026-10-20',
    });
  });

  it('refuses a period that starts before the history of the plan, in the zone of the workspace', async () => {
    const deps = {
      history: fixedAnalyticsHistory(90),
      clock: { now: () => new Date('2026-10-16T23:30:00Z') },
    };
    // 01:30 on October 17 in Berlin: the history reaches back to July 20.
    await expect(
      resolveAnalyticsPeriod(
        deps,
        { organizationId: 'org-1', timeZone: 'Europe/Berlin' },
        { from: '2026-07-20' },
      ),
    ).resolves.toMatchObject({ from: '2026-07-20', to: '2026-10-17', historyFrom: '2026-07-20' });
    const refused = resolveAnalyticsPeriod(
      deps,
      { organizationId: 'org-1', timeZone: 'Europe/Berlin' },
      { from: '2026-07-19' },
    );
    await expect(refused).rejects.toBeInstanceOf(AnalyticsHistoryExceededError);
    await expect(refused).rejects.toMatchObject({ params: { earliest: '2026-07-20' } });
  });
});

describe('analytics breakdowns', () => {
  const post = (
    platform: 'LINKEDIN' | 'INSTAGRAM',
    publishedAt: string,
    metrics: BreakdownPost['metrics'],
    style: BreakdownPost['style'] = null,
  ): BreakdownPost => ({ platform, publishedAt: new Date(publishedAt), style, metrics });
  const story = { id: 'style-1', key: 'storytelling', name: 'Storytelling', preset: true };
  const own = { id: 'style-2', key: 'custom-kurz', name: 'Kurz und knapp', preset: false };

  it('groups by platform with the views of Instagram as its impressions', () => {
    expect(
      breakdownOf(
        [
          post('LINKEDIN', '2026-10-12T08:00:00Z', {
            impressions: 100,
            reach: 80,
            views: null,
            engagements: 10,
          }),
          post('INSTAGRAM', '2026-10-12T09:00:00Z', {
            impressions: null,
            reach: 300,
            views: 400,
            engagements: 20,
          }),
          post('INSTAGRAM', '2026-10-13T09:00:00Z', null),
        ],
        'platform',
        'Europe/Berlin',
      ),
    ).toEqual([
      {
        key: 'INSTAGRAM',
        label: null,
        preset: null,
        posts: 2,
        impressions: 400,
        engagements: 20,
        engagementRate: 0.05,
      },
      {
        key: 'LINKEDIN',
        label: null,
        preset: null,
        posts: 1,
        impressions: 100,
        engagements: 10,
        engagementRate: 0.1,
      },
    ]);
  });

  it('names preset styles by key and custom styles by name, and counts every weekday', () => {
    const posts = [
      post(
        'LINKEDIN',
        '2026-10-12T08:00:00Z',
        { impressions: 10, reach: null, views: null, engagements: 1 },
        story,
      ),
      post(
        'LINKEDIN',
        '2026-10-13T08:00:00Z',
        { impressions: 10, reach: null, views: null, engagements: 1 },
        story,
      ),
      post('LINKEDIN', '2026-10-13T08:00:00Z', null, own),
      // 23:30 on Sunday in Berlin is still Sunday there.
      post('LINKEDIN', '2026-10-18T21:30:00Z', null),
    ];
    expect(
      breakdownOf(posts, 'style', 'Europe/Berlin').map((group) => [
        group.key,
        group.label,
        group.preset,
        group.posts,
      ]),
    ).toEqual([
      ['style-1', 'storytelling', true, 2],
      ['none', null, null, 1],
      ['style-2', 'Kurz und knapp', false, 1],
    ]);
    const weekdays = breakdownOf(posts, 'weekday', 'Europe/Berlin');
    expect(weekdays.map((group) => [group.key, group.posts])).toEqual([
      ['1', 1],
      ['2', 2],
      ['3', 0],
      ['4', 0],
      ['5', 0],
      ['6', 0],
      ['7', 1],
    ]);
    expect(weekdays[2]).toMatchObject({ impressions: null, engagements: null, engagementRate: null });
  });
});
