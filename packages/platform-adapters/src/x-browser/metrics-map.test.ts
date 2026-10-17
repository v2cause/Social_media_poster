import { describe, expect, it } from 'vitest';

import { normalizeXBrowserPostMetrics } from './metrics-map';

// Architecture 8: the counters of the web app of X in the normalized metrics; what it does not
// show stays null, never 0.

describe('normalizeXBrowserPostMetrics', () => {
  it('reads views as impressions, replies as comments, reposts and quotes as shares, bookmarks as saves', () => {
    expect(
      normalizeXBrowserPostMetrics({
        views: 4210,
        likes: 87,
        replies: 6,
        reposts: 11,
        quotes: 2,
        bookmarks: 9,
      }),
    ).toEqual({
      impressions: 4210,
      reach: null,
      views: null,
      likes: 87,
      comments: 6,
      shares: 13,
      clicks: null,
      saves: 9,
    });
  });

  it('keeps what the web app does not report as null', () => {
    expect(
      normalizeXBrowserPostMetrics({
        views: null,
        likes: null,
        replies: null,
        reposts: null,
        quotes: 3,
        bookmarks: null,
      }),
    ).toEqual({
      impressions: null,
      reach: null,
      views: null,
      likes: null,
      comments: null,
      shares: 3,
      clicks: null,
      saves: null,
    });
    expect(
      normalizeXBrowserPostMetrics({
        views: 1,
        likes: 0,
        replies: 0,
        reposts: null,
        quotes: null,
        bookmarks: 0,
      }).shares,
    ).toBeNull();
  });
});
