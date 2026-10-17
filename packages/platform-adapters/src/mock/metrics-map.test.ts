import { describe, expect, it } from 'vitest';

import { MAP_VERSION, normalizeMockAccountMetrics, normalizeMockPostMetrics } from './metrics-map';

// Guide step 5.2: the mapping of the mock platforms keeps missing metrics as null and refuses an
// answer of another shape instead of guessing.

describe('metrics map of the mock platforms', () => {
  it('normalizes the raw answer and keeps missing metrics as null', () => {
    expect(MAP_VERSION).toBe(1);
    expect(
      normalizeMockPostMetrics({
        mock: {
          impressions: 120,
          reach: null,
          views: null,
          likes: 6,
          comments: 0,
          shares: 1,
          clicks: 2,
          saves: null,
        },
      }),
    ).toEqual({
      impressions: 120,
      reach: null,
      views: null,
      likes: 6,
      comments: 0,
      shares: 1,
      clicks: 2,
      saves: null,
    });
    expect(normalizeMockAccountMetrics({ mock: { followers: 512, reach: null, profileViews: 40 } })).toEqual({
      followers: 512,
      reach: null,
      profileViews: 40,
    });
  });

  it('refuses an answer of another shape', () => {
    expect(() => normalizeMockPostMetrics({ impressions: 5 })).toThrow();
    expect(() =>
      normalizeMockPostMetrics({
        mock: {
          impressions: -1,
          reach: null,
          views: null,
          likes: null,
          comments: null,
          shares: null,
          clicks: null,
          saves: null,
        },
      }),
    ).toThrow();
  });
});
