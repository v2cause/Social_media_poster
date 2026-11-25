import { describe, expect, it } from 'vitest';

import { linkedInConfigFromEnv, linkedInEnvSchema } from './config';
import { MAP_VERSION, normalizeLinkedInAccountMetrics, normalizeLinkedInPostMetrics } from './metrics-map';

// Guide step 5.2: normalization tests with payloads shaped like the documented samples
// (post-statistics, share-statistics, follower-statistics; checked 2026-11-25).

describe('LinkedIn metrics map', () => {
  it('has a version', () => {
    expect(MAP_VERSION).toBe(1);
  });

  it('maps member post analytics; metrics LinkedIn does not report stay null', () => {
    expect(
      normalizeLinkedInPostMetrics({
        linkedin: {
          source: 'memberCreatorPostAnalytics',
          counts: { IMPRESSION: 1520, MEMBERS_REACHED: 980, REACTION: 41, COMMENT: 7, RESHARE: null },
        },
      }),
    ).toEqual({
      impressions: 1520,
      reach: 980,
      views: null,
      likes: 41,
      comments: 7,
      shares: null,
      clicks: null,
      saves: null,
    });
  });

  it('maps page share statistics, a negative likeCount as unknown, a missing post as zeros', () => {
    expect(
      normalizeLinkedInPostMetrics({
        linkedin: {
          source: 'organizationalEntityShareStatistics',
          totalShareStatistics: {
            clickCount: 78,
            commentCount: 24,
            impressionCount: 5287,
            likeCount: -2,
            shareCount: 5,
          },
        },
      }),
    ).toEqual({
      impressions: 5287,
      reach: null,
      views: null,
      likes: null,
      comments: 24,
      shares: 5,
      clicks: 78,
      saves: null,
    });
    expect(
      normalizeLinkedInPostMetrics({
        linkedin: { source: 'organizationalEntityShareStatistics', totalShareStatistics: null },
      }),
    ).toMatchObject({ impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0, saves: null });
  });

  it('maps followers of members and pages, and refuses unknown shapes', () => {
    expect(
      normalizeLinkedInAccountMetrics({
        linkedin: { source: 'memberFollowersCount', memberFollowersCount: 100 },
      }),
    ).toEqual({ followers: 100, reach: null, profileViews: null });
    expect(
      normalizeLinkedInAccountMetrics({ linkedin: { source: 'networkSizes', firstDegreeSize: 219145 } }),
    ).toEqual({ followers: 219145, reach: null, profileViews: null });
    expect(() => normalizeLinkedInPostMetrics({ mock: {} })).toThrow();
  });
});

describe('linkedInConfigFromEnv', () => {
  it('reads the app credentials, the version and the features', () => {
    const env = linkedInEnvSchema.parse({
      LINKEDIN_CLIENT_ID: '861hhm46p48to2',
      LINKEDIN_CLIENT_SECRET: 'secret',
      LINKEDIN_VERSION: '',
      LINKEDIN_ORGANIZATIONS: 'true',
    });
    expect(linkedInConfigFromEnv(env)).toEqual({
      clientId: '861hhm46p48to2',
      clientSecret: 'secret',
      version: '202611',
      features: { memberPostAnalytics: false, memberFollowerStatistics: false, organizations: true },
    });
    expect(() => linkedInConfigFromEnv({ ...env, LINKEDIN_VERSION: '2026-11' })).toThrow();
  });
});
