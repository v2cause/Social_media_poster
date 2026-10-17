import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_TYPES,
  notificationContentSchema,
  notificationPreferencesSchema,
  notificationQuerySchema,
} from './notifications';

describe('notification contracts', () => {
  it('reads the filter of the list from the query string', () => {
    expect(notificationQuerySchema.parse({ unread: 'true', limit: '5' })).toEqual({ unread: true, limit: 5 });
    expect(notificationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(notificationQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('takes the settings of each type once', () => {
    const preference = { type: 'publish-failed' as const, inApp: true, email: false };
    expect(notificationPreferencesSchema.safeParse({ preferences: [preference] }).success).toBe(true);
    expect(notificationPreferencesSchema.safeParse({ preferences: [preference, preference] }).success).toBe(
      false,
    );
    expect(
      notificationPreferencesSchema.safeParse({
        preferences: NOTIFICATION_TYPES.map((type) => ({ type, inApp: false, email: false })),
      }).success,
    ).toBe(true);
  });

  it('knows the content of every type', () => {
    expect(
      notificationContentSchema.safeParse({
        type: 'reauth-required',
        connectionId: '0192f5d4-0000-7000-8000-000000000001',
        platform: 'LINKEDIN',
        accounts: ['Mira'],
        reason: 'EXPIRED',
        scheduledVariants: 2,
      }).success,
    ).toBe(true);
    expect(notificationContentSchema.safeParse({ type: 'weekly-digest' }).success).toBe(false);
  });
});
