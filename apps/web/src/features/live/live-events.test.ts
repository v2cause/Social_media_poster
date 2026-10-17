import { describe, expect, it } from 'vitest';

import { parseLiveEvent, queryKeysAfterReconnect, queryKeysOf } from './live-events';

const postId = '0192f5d4-0000-7000-8000-000000000002';

describe('live events in the browser', () => {
  it('makes the posts stale on a status change and the bell on a new notification', () => {
    const status = parseLiveEvent(
      JSON.stringify({
        type: 'variant.status',
        variantId: '0192f5d4-0000-7000-8000-000000000001',
        postId,
        status: 'PUBLISHED',
        scheduleVersion: 2,
      }),
    );
    const notification = parseLiveEvent(
      JSON.stringify({ type: 'notification.created', id: '0192f5d4-0000-7000-8000-000000000003' }),
    );

    expect(status && queryKeysOf(status, 'nordlicht')).toEqual([
      ['/api/w/nordlicht/posts'],
      [`/api/w/nordlicht/posts/${postId}`],
    ]);
    expect(notification && queryKeysOf(notification, 'nordlicht')).toEqual([['/api/me/notifications']]);
    expect(queryKeysAfterReconnect('nordlicht')).toEqual([
      ['/api/w/nordlicht/posts'],
      ['/api/me/notifications'],
    ]);
  });

  it('ignores data that is no event of the contract', () => {
    expect(parseLiveEvent('not json')).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: 'variant.status', variantId: 'x' }))).toBeNull();
  });
});
