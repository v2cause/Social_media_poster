import type { Provider } from '@nestjs/common';
import { MarkNotificationsRead, SetNotificationPreferences, systemClock } from '@smp/core';
import { NotificationReadModel, PrismaUserNotifications, type PrismaClient } from '@smp/db';

import { DATABASE_CLIENT } from '../../infrastructure/clients.module';

export const NOTIFICATION_READ_MODEL = Symbol('NOTIFICATION_READ_MODEL');

/** The notifications of the signed-in user, wired to PostgreSQL (guide step 4.9). */
export const notificationProviders: Provider[] = [
  {
    provide: NOTIFICATION_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new NotificationReadModel(base),
  },
  {
    provide: MarkNotificationsRead,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) =>
      new MarkNotificationsRead({ notifications: new PrismaUserNotifications(base), clock: systemClock }),
  },
  {
    provide: SetNotificationPreferences,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) =>
      new SetNotificationPreferences({ notifications: new PrismaUserNotifications(base) }),
  },
];
