import { describe, expect, it } from 'vitest';

import { parseLiveEvent, queryKeysAfterReconnect, queryKeysOf } from './live-events';

const postId = '0192f5d4-0000-7000-8000-000000000002';

describe('live events in the browser', () => {
  it('makes the posts and the variant lists stale on a status change and the bell on a new notification', () => {
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
      ['/api/w/nordlicht/variants'],
    ]);
    expect(notification && queryKeysOf(notification, 'nordlicht')).toEqual([['/api/me/notifications']]);
    expect(queryKeysAfterReconnect('nordlicht')).toEqual([
      ['/api/w/nordlicht/posts'],
      ['/api/w/nordlicht/variants'],
      ['/api/me/notifications'],
    ]);
  });

  it('makes the login of X stale with each step, and the accounts once it succeeded', () => {
    const loginId = '0192f5d4-0000-7000-8000-000000000004';
    const step = (status: string) =>
      parseLiveEvent(JSON.stringify({ type: 'xb.login', loginSessionId: loginId, status }));
    const awaiting = step('AWAITING_2FA');
    const succeeded = step('SUCCEEDED');

    const login = [`/api/w/nordlicht/x-browser/login-sessions/${loginId}`];
    expect(awaiting && queryKeysOf(awaiting, 'nordlicht')).toEqual([login]);
    expect(succeeded && queryKeysOf(succeeded, 'nordlicht')).toEqual([login, ['/api/w/nordlicht/accounts']]);
    expect(step('SOMETHING_NEW')).toBeNull();
  });

  it('ignores data that is no event of the contract', () => {
    expect(parseLiveEvent('not json')).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: 'variant.status', variantId: 'x' }))).toBeNull();
  });
});
