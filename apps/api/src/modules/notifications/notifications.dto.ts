import {
  markedNotificationsSchema,
  markNotificationsReadSchema,
  notificationPageSchema,
  notificationPreferencesSchema,
  notificationQuerySchema,
  unreadNotificationsSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of the notifications of the signed-in user (guide step 4.9). The
// schemas live in @smp/contracts, where the bell and the settings page use them too.

export class NotificationQueryDto extends createZodDto(notificationQuerySchema) {}
export class NotificationPageDto extends createZodDto(notificationPageSchema) {}
export class UnreadNotificationsDto extends createZodDto(unreadNotificationsSchema) {}
export class MarkNotificationsReadDto extends createZodDto(markNotificationsReadSchema) {}
export class MarkedNotificationsDto extends createZodDto(markedNotificationsSchema) {}
export class NotificationPreferencesDto extends createZodDto(notificationPreferencesSchema) {}
