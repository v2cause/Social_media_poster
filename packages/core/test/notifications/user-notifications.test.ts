import { describe, expect, it } from 'vitest';

import {
  MarkNotificationsRead,
  SetNotificationPreferences,
  type NotificationPreference,
  type UserNotifications,
} from '../../src';

// Guide step 4.9: the signed-in user marks notifications read and chooses how each type arrives.

const NOW = new Date('2026-10-16T12:00:00Z');

const recording = () => {
  const reads: { userId: string; ids: readonly string[] | 'all'; at: Date }[] = [];
  const saved: { userId: string; preferences: readonly NotificationPreference[] }[] = [];
  const notifications: UserNotifications = {
    markRead: (userId, ids, at) => {
      reads.push({ userId, ids, at });
      return Promise.resolve(ids === 'all' ? 3 : ids.length);
    },
    savePreferences: (userId, preferences) => {
      saved.push({ userId, preferences });
      return Promise.resolve();
    },
  };
  return { notifications, reads, saved };
};

describe('MarkNotificationsRead', () => {
  it('marks the given notifications or all of the user, at the time of the clock', async () => {
    const { notifications, reads } = recording();
    const mark = new MarkNotificationsRead({ notifications, clock: { now: () => NOW } });

    await expect(mark.execute({ userId: 'u-1', ids: ['n-1', 'n-2'] })).resolves.toEqual({ marked: 2 });
    await expect(mark.execute({ userId: 'u-1', ids: 'all' })).resolves.toEqual({ marked: 3 });
    await expect(mark.execute({ userId: 'u-1', ids: [] })).resolves.toEqual({ marked: 0 });

    expect(reads).toEqual([
      { userId: 'u-1', ids: ['n-1', 'n-2'], at: NOW },
      { userId: 'u-1', ids: 'all', at: NOW },
    ]);
  });
});

describe('SetNotificationPreferences', () => {
  it('stores each type once, the last setting of a type counting', async () => {
    const { notifications, saved } = recording();
    const set = new SetNotificationPreferences({ notifications });

    await set.execute({
      userId: 'u-1',
      preferences: [
        { type: 'publish-failed', inApp: true, email: true },
        { type: 'token-expiring', inApp: true, email: false },
        { type: 'publish-failed', inApp: false, email: true },
      ],
    });
    await set.execute({ userId: 'u-1', preferences: [] });

    expect(saved).toEqual([
      {
        userId: 'u-1',
        preferences: [
          { type: 'publish-failed', inApp: false, email: true },
          { type: 'token-expiring', inApp: true, email: false },
        ],
      },
    ]);
  });
});
