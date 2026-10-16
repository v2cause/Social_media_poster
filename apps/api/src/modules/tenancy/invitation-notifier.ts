import { Inject, Injectable } from '@nestjs/common';
import { toLocale } from '@smp/contracts';
import type { InvitationMessage, InvitationNotifier } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { NotificationProducer } from '@smp/queue';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { TENANCY_READ_MODEL } from '../../infrastructure/clients.module';

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

/**
 * Queues the invitation email (guide step 1.8). The link leads to the invite page of the web
 * app; the language is the invitee's if the address has an account, else the inviter's.
 */
@Injectable()
export class QueueInvitationNotifier implements InvitationNotifier {
  constructor(
    private readonly notifications: NotificationProducer,
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async invitationCreated(message: InvitationMessage): Promise<void> {
    const context = await this.readModel.invitationMailContext(
      { userId: message.inviterUserId, organizationId: message.organizationId },
      message.email,
    );
    await this.notifications.dispatchEmail(message.email, {
      template: 'invitation',
      locale: toLocale(context.locale),
      url: new URL(`/invite/${encodeURIComponent(message.token)}`, this.env.APP_URL).toString(),
      organizationName: context.organizationName,
      inviterName: context.inviterName,
      role: message.role,
    });
  }
}
