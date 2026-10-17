import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { notificationContentSchema, type NotificationDto } from '@smp/contracts';
import { MarkNotificationsRead, SetNotificationPreferences } from '@smp/core';
import type { NotificationReadModel, NotificationView } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import { UserScope } from '../../common/decorators/access.decorators';
import type { AuthSession } from '../identity/auth';
import { CurrentUser } from '../identity/current-user.decorator';
import {
  MarkedNotificationsDto,
  MarkNotificationsReadDto,
  NotificationPageDto,
  NotificationPreferencesDto,
  NotificationQueryDto,
  UnreadNotificationsDto,
} from './notifications.dto';
import { NOTIFICATION_READ_MODEL } from './notifications.providers';

/**
 * The notifications of the signed-in user and the settings of their channels (guide step 4.9):
 * the bell lists and marks them, the account page chooses per type how they arrive.
 */
@ApiTags('notifications')
@UserScope()
@Controller('me')
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    @Inject(NOTIFICATION_READ_MODEL) private readonly readModel: NotificationReadModel,
    private readonly markNotificationsRead: MarkNotificationsRead,
    private readonly setNotificationPreferences: SetNotificationPreferences,
  ) {}

  /** Newest first; a notification whose content no longer fits the contract is left out. */
  @Get('notifications')
  @ZodResponse({ type: NotificationPageDto })
  async list(
    @CurrentUser() user: AuthSession['user'],
    @Query() query: NotificationQueryDto,
  ): Promise<NotificationPageDto> {
    const page = await this.readModel.list(user.id, {
      unreadOnly: query.unread === true,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.flatMap((item) => this.toDto(item)),
      nextCursor: page.nextCursor,
      unread: page.unread,
    };
  }

  @Get('notifications/unread-count')
  @ZodResponse({ type: UnreadNotificationsDto })
  async unread(@CurrentUser() user: AuthSession['user']): Promise<UnreadNotificationsDto> {
    return { unread: await this.readModel.unreadCount(user.id) };
  }

  @Post('notifications/read')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: MarkedNotificationsDto })
  markRead(
    @CurrentUser() user: AuthSession['user'],
    @Body() body: MarkNotificationsReadDto,
  ): Promise<MarkedNotificationsDto> {
    return this.markNotificationsRead.execute({ userId: user.id, ids: body.ids });
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: MarkedNotificationsDto })
  markAllRead(@CurrentUser() user: AuthSession['user']): Promise<MarkedNotificationsDto> {
    return this.markNotificationsRead.execute({ userId: user.id, ids: 'all' });
  }

  /** Every type; without a setting of the user both channels are on. */
  @Get('notification-preferences')
  @ZodResponse({ type: NotificationPreferencesDto })
  async preferences(@CurrentUser() user: AuthSession['user']): Promise<NotificationPreferencesDto> {
    return { preferences: await this.readModel.preferences(user.id) };
  }

  /** Changes the given types and answers with the settings of every type. */
  @Put('notification-preferences')
  @ZodResponse({ type: NotificationPreferencesDto })
  async setPreferences(
    @CurrentUser() user: AuthSession['user'],
    @Body() body: NotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    await this.setNotificationPreferences.execute({ userId: user.id, preferences: body.preferences });
    return { preferences: await this.readModel.preferences(user.id) };
  }

  private toDto(item: NotificationView): NotificationDto[] {
    const content = notificationContentSchema.safeParse(item.payload);
    if (!content.success) {
      this.logger.warn(`Notification ${item.id} of type ${item.type} does not fit its contract.`);
      return [];
    }
    return [
      {
        id: item.id,
        createdAt: item.createdAt.toISOString(),
        readAt: item.readAt?.toISOString() ?? null,
        workspace: item.workspace,
        content: content.data,
      },
    ];
  }
}
