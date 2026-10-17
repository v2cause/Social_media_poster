import { describe, expect, it } from 'vitest';

import { changeOf, isEmptyOverview, maxOf } from './analytics-model';

describe('changeOf', () => {
  it('relates a count to the period before', () => {
    expect(changeOf(1_120, 1_000, 'count')).toEqual({ kind: 'ratio', ratio: 0.12, direction: 'up' });
    expect(changeOf(750, 1_000, 'count')).toEqual({ kind: 'ratio', ratio: -0.25, direction: 'down' });
    expect(changeOf(1_000, 1_000, 'count')).toEqual({ kind: 'ratio', ratio: 0, direction: 'flat' });
  });

  it('relates growth to the size of the growth before, even when it was negative', () => {
    expect(changeOf(20, -10, 'count')).toEqual({ kind: 'ratio', ratio: 3, direction: 'up' });
  });

  it('shows rates in percentage points', () => {
    const change = changeOf(0.05, 0.04, 'rate');
    expect(change.kind).toBe('points');
    expect(change.kind === 'points' ? change.points : 0).toBeCloseTo(1);
    expect(changeOf(0.04, 0.04, 'rate')).toMatchObject({ direction: 'flat' });
  });

  it('compares nothing without a value or from 0 to more', () => {
    expect(changeOf(null, 10, 'count')).toEqual({ kind: 'none' });
    expect(changeOf(10, null, 'count')).toEqual({ kind: 'none' });
    expect(changeOf(10, 0, 'count')).toEqual({ kind: 'none' });
    expect(changeOf(0, 0, 'count')).toEqual({ kind: 'ratio', ratio: 0, direction: 'flat' });
  });
});

describe('isEmptyOverview', () => {
  const series = {
    days: ['2026-10-16', '2026-10-17'],
    impressions: [null, null],
    reach: [null, null],
    engagements: [null, null],
    engagementRate: [null, null],
    followers: [null, null],
    postsPublished: [0, 0],
  };

  it('is empty when no day has a number other than 0', () => {
    expect(isEmptyOverview({ series })).toBe(true);
    expect(isEmptyOverview({ series: { ...series, followers: [null, 120] } })).toBe(false);
    expect(isEmptyOverview({ series: { ...series, postsPublished: [1, 0] } })).toBe(false);
  });
});

describe('maxOf', () => {
  it('ignores the gaps', () => {
    expect(maxOf([null, 3, null, 7, 2])).toBe(7);
    expect(maxOf([null, null])).toBeNull();
    expect(maxOf([-2, -5])).toBe(-2);
  });
});
