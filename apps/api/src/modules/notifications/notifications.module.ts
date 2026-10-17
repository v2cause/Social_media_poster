import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { notificationProviders } from './notifications.providers';

/** The notifications of the signed-in user and their settings (guide step 4.9). */
@Module({ controllers: [NotificationsController], providers: notificationProviders })
export class NotificationsModule {}
