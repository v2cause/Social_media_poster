import type { Clock } from '../../shared/ports/clock';
import type { NotificationPreference, UserNotifications } from '../ports/notification-store';

// The notifications of the signed-in user (guide step 4.9): marking them read, and choosing per
// type how they arrive. Users act on their own only; row-level security holds that as well.

export class MarkNotificationsRead {
  constructor(private readonly deps: { notifications: UserNotifications; clock: Clock }) {}

  /** The given notifications, or all of the user. */
  async execute(input: { userId: string; ids: readonly string[] | 'all' }): Promise<{ marked: number }> {
    if (input.ids !== 'all' && input.ids.length === 0) {
      return { marked: 0 };
    }
    const marked = await this.deps.notifications.markRead(input.userId, input.ids, this.deps.clock.now());
    return { marked };
  }
}

export class SetNotificationPreferences {
  constructor(private readonly deps: { notifications: UserNotifications }) {}

  /** Each type once; for a type named twice the last setting counts. */
  async execute(input: { userId: string; preferences: readonly NotificationPreference[] }): Promise<void> {
    const byType = new Map(input.preferences.map((preference) => [preference.type, preference]));
    if (byType.size > 0) {
      await this.deps.notifications.savePreferences(input.userId, [...byType.values()]);
    }
  }
}
