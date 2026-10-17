import { describe, expect, it } from 'vitest';

import {
  cadenceHours,
  engagementsOf,
  localDayRange,
  metricsDueAt,
  nextDay,
  nextPollAfter,
  type NormalizedPostMetrics,
} from '../../src';

// Guide step 5.2 and architecture 8: the polling cascade per platform, the derived engagements
// and the days in the time zone of a workspace.

const HOUR = 60 * 60 * 1000;
const published = new Date('2026-10-16T12:00:00Z');

const none: NormalizedPostMetrics = {
  impressions: null,
  reach: null,
  views: null,
  likes: null,
  comments: null,
  shares: null,
  clicks: null,
  saves: null,
};

describe('analytics rules', () => {
  it('polls after 1 h, 24 h, 72 h, 7 d and 30 d, on X from a day to a week', () => {
    expect(cadenceHours('LINKEDIN', 'API')).toEqual([1, 24, 72, 168, 720]);
    expect(cadenceHours('INSTAGRAM', 'MOCK')).toEqual([1, 24, 72, 168, 720]);
    expect(cadenceHours('X', 'API')).toEqual([24, 72, 168]);
    expect(cadenceHours('X', 'MOCK')).toEqual([24, 72, 168]);
    expect(cadenceHours('X', 'BROWSER')).toEqual([24, 168]);
    expect(metricsDueAt('FACEBOOK', 'API', published, 0)).toEqual(new Date(published.getTime() + HOUR));
    expect(metricsDueAt('FACEBOOK', 'API', published, 4)).toEqual(new Date(published.getTime() + 720 * HOUR));
    expect(metricsDueAt('FACEBOOK', 'API', published, 5)).toBeNull();
    expect(metricsDueAt('X', 'API', published, 3)).toBeNull();
  });

  it('runs the cascade faster with a scale: 60 turns an hour into a minute', () => {
    expect(metricsDueAt('LINKEDIN', 'API', published, 1, 60)).toEqual(
      new Date(published.getTime() + 24 * 60 * 1000),
    );
  });

  it('skips the polls whose time passed while the poll waited', () => {
    const late = new Date(published.getTime() + 100 * HOUR);
    expect(nextPollAfter('LINKEDIN', 'API', published, 0, late)).toEqual({
      step: 3,
      at: new Date(published.getTime() + 168 * HOUR),
    });
    const onTime = new Date(published.getTime() + HOUR);
    expect(nextPollAfter('LINKEDIN', 'API', published, 0, onTime)).toEqual({
      step: 1,
      at: new Date(published.getTime() + 24 * HOUR),
    });
    expect(nextPollAfter('X', 'API', published, 2, new Date(published.getTime() + 168 * HOUR))).toBeNull();
  });

  it('adds up the reported interactions and keeps null apart from 0', () => {
    expect(engagementsOf(none)).toBeNull();
    const seenWithoutLikes: NormalizedPostMetrics = { ...none, impressions: 500, likes: 0 };
    expect(engagementsOf(seenWithoutLikes)).toBe(0);
    expect(engagementsOf({ ...none, likes: 10, comments: 2, shares: 1, saves: 3, clicks: 4 })).toBe(20);
  });

  it('measures a day in the time zone of the workspace, also on the day the clocks change', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(localDayRange('2026-10-16', 'Europe/Berlin')).toEqual({
      from: new Date('2026-10-15T22:00:00Z'),
      to: new Date('2026-10-16T22:00:00Z'),
    });
    // October 25 has 25 hours in Berlin.
    const { from, to } = localDayRange('2026-10-25', 'Europe/Berlin');
    expect(to.getTime() - from.getTime()).toBe(25 * HOUR);
  });
});
