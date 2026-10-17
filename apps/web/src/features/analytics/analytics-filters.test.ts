import { describe, expect, it } from 'vitest';

import {
  accountIdsOf,
  analyticsQuerySchema,
  filterParamsOf,
  granularityOf,
  periodOf,
  platformsOf,
  toggled,
} from './analytics-filters';

const ACCOUNT = '0190a6a2-6c5e-7d3f-8a1b-2c3d4e5f6a7b';
const OTHER = '0190a6a2-6c5e-7d3f-8a1b-2c3d4e5f6a7c';

describe('the analytics query', () => {
  it('falls back to the last 30 days, all platforms and the default views', () => {
    expect(analyticsQuerySchema.parse({})).toEqual({
      period: '30',
      from: '',
      to: '',
      platform: '',
      accountId: '',
      metric: 'impressions',
      granularity: '',
      compare: 'impressions',
      sort: 'engagements',
      by: 'style',
    });
  });

  it('keeps valid lists and drops a list with an unknown part', () => {
    const query = analyticsQuerySchema.parse({ platform: 'LINKEDIN,X', accountId: `${ACCOUNT},${OTHER}` });
    expect(platformsOf(query)).toEqual(['LINKEDIN', 'X']);
    expect(accountIdsOf(query)).toEqual([ACCOUNT, OTHER]);

    expect(analyticsQuerySchema.parse({ platform: 'LINKEDIN,TIKTOK', accountId: 'nope' })).toMatchObject({
      platform: '',
      accountId: '',
    });
    expect(analyticsQuerySchema.parse({ period: '14', metric: 'hearts', by: 'hour' })).toMatchObject({
      period: '30',
      metric: 'impressions',
      by: 'style',
    });
  });

  it('toggles a value of a list once', () => {
    expect(toggled('', 'X', true)).toBe('X');
    expect(toggled('X', 'X', true)).toBe('X');
    expect(toggled('LINKEDIN,X', 'LINKEDIN', false)).toBe('X');
    expect(toggled('X,X,LINKEDIN', 'FACEBOOK', true)).toBe('X,LINKEDIN,FACEBOOK');
  });
});

describe('periodOf', () => {
  const today = '2026-10-17';

  it('counts the presets back from today, today included', () => {
    expect(periodOf({ period: '7', from: '', to: '' }, today)).toEqual({
      period: { from: '2026-10-11', to: today },
      problem: null,
    });
    expect(periodOf({ period: '90', from: '2026-01-01', to: '2026-01-02' }, today).period).toEqual({
      from: '2026-07-20',
      to: today,
    });
  });

  it('takes a period of its own and names what is wrong with it', () => {
    expect(periodOf({ period: 'custom', from: '2026-09-01', to: '2026-09-30' }, today)).toEqual({
      period: { from: '2026-09-01', to: '2026-09-30' },
      problem: null,
    });
    expect(periodOf({ period: 'custom', from: '2026-09-01', to: '' }, today).problem).toBe('incomplete');
    expect(periodOf({ period: 'custom', from: '2026-09-30', to: '2026-09-01' }, today).problem).toBe(
      'inverted',
    );
    expect(periodOf({ period: 'custom', from: '2025-01-01', to: '2026-01-02' }, today).problem).toBe(
      'too_long',
    );
    expect(periodOf({ period: 'custom', from: '2025-01-01', to: '2026-01-01' }, today).problem).toBeNull();
  });
});

describe('filterParamsOf', () => {
  it('sends the period and only the lists that are set', () => {
    const period = { from: '2026-09-18', to: '2026-10-17' };
    expect(filterParamsOf(analyticsQuerySchema.parse({}), period)).toEqual(period);
    expect(
      filterParamsOf(analyticsQuerySchema.parse({ platform: 'X,X,FACEBOOK', accountId: ACCOUNT }), period),
    ).toEqual({ ...period, platform: 'X,FACEBOOK', accountId: ACCOUNT });
  });
});

describe('granularityOf', () => {
  it('shows days up to three months and weeks beyond, unless chosen', () => {
    expect(granularityOf({ granularity: '' }, { from: '2026-07-18', to: '2026-10-17' })).toBe('day');
    expect(granularityOf({ granularity: '' }, { from: '2026-01-01', to: '2026-10-17' })).toBe('week');
    expect(granularityOf({ granularity: 'month' }, { from: '2026-10-11', to: '2026-10-17' })).toBe('month');
  });
});
