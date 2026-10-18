import { Inject, Injectable, Logger } from '@nestjs/common';
import { toLocale } from '@smp/contracts';
import type { InvitationMessage, InvitationNotifier } from '@smp/core';
import type { TenancyReadModel } from '@smp/db';
import { NotificationProducer } from '@smp/queue';
import type Redis from 'ioredis';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { REDIS_CLIENT, TENANCY_READ_MODEL } from '../../infrastructure/clients.module';
import { accountDigest } from '../identity/auth-hooks';

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

/**
 * Invitation emails per address and hour, from all organizations together; more are dropped
 * (guide step 8.4). Anyone can create an organization and invite any address, so without it one
 * account could send an address 40 emails an hour: 30 invitations, each replacing the one before,
 * and 10 resends.
 */
export const INVITATION_MAILS_PER_ADDRESS_AND_HOUR = 5;
const HOUR_SECONDS = 60 * 60;

// INCR with an expiry set on the first hit, as in the password check of the API.
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

/**
 * Queues the invitation email (guide step 1.8). The link leads to the invite page of the web
 * app; the language is the invitee's if the address has an account, else the inviter's. Beyond
 * the limit per address the invitation stays valid without an email; the inviter can send it
 * again an hour later.
 */
@Injectable()
export class QueueInvitationNotifier implements InvitationNotifier {
  private readonly logger = new Logger(QueueInvitationNotifier.name);

  constructor(
    private readonly notifications: NotificationProducer,
    @Inject(TENANCY_READ_MODEL) private readonly readModel: TenancyReadModel,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async invitationCreated(message: InvitationMessage): Promise<void> {
    const digest = accountDigest(message.email);
    // The counter lives for an hour from the first email on.
    const sent = Number(
      await this.redis.eval(INCREMENT, 1, `invitation-mail:${digest}`, String(HOUR_SECONDS)),
    );
    if (sent > INVITATION_MAILS_PER_ADDRESS_AND_HOUR) {
      this.logger.warn({ invitationId: message.invitationId, account: digest }, 'invitation.mail_dropped');
      return;
    }
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
