import { describe, expect, it } from 'vitest';

import { demoAnalyticsPlan } from './demo-analytics';

// The analytics test reads the style breakdown of the last 30 days on the demo seed (guide step
// 5.5). Which days are weekend days depends on the day the seed runs on; every style and posts
// without one must be there on any day and at any hour.

const STYLE_KEYS = [
  'professional',
  'storytelling',
  'casual',
  'educational',
  'thought_leadership',
  'promotional',
];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('the demo analytics', () => {
  it('hold every style and posts without one in the last 30 days, whatever day the seed runs on', () => {
    const styleIds = new Map(STYLE_KEYS.map((key) => [key, `style-${key}`]));
    // Every five hours over two weeks: every weekday, around midnight in Berlin as well.
    for (let step = 0; step < (14 * 24) / 5; step += 1) {
      const now = new Date(Date.parse('2026-10-12T21:30:00Z') + step * 5 * HOUR_MS);
      const plan = demoAnalyticsPlan({
        workspaceId: '0192f000-0000-7000-8000-0000000000a1',
        timeZone: 'Europe/Berlin',
        now,
        ownerId: null,
        styleIds,
      });

      // 28 days lie within the 30 local days of the view at any hour.
      const recent = plan.posts.filter(
        (post) => new Date(post.updatedAt ?? 0).getTime() >= now.getTime() - 28 * DAY_MS,
      );
      const styles = new Set(recent.map((post) => post.styleId ?? null));
      expect(
        [...styleIds.values(), null].filter((style) => !styles.has(style)),
        now.toISOString(),
      ).toEqual([]);
    }
  });
});
