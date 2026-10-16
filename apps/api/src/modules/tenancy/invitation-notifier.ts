import { Logger } from '@nestjs/common';
import type { InvitationMessage, InvitationNotifier } from '@smp/core';

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

/**
 * Placeholder until the notification queue exists (guide step 1.8): records that an invitation
 * was created, without address or token.
 */
export class LoggingInvitationNotifier implements InvitationNotifier {
  private readonly logger = new Logger('Invitations');

  invitationCreated(message: InvitationMessage): Promise<void> {
    this.logger.log({ invitationId: message.invitationId }, 'invitation.created');
    return Promise.resolve();
  }
}
