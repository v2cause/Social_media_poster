import { NotPermittedError } from '../../shared/domain/errors';
import { InvitationNotFoundError, InvitationUsedError } from '../domain/errors';
import { INVITATION_TTL_MS } from '../domain/invitation';
import { assertCanGrantRole, isManager } from '../domain/roles';
import type { OrganizationActor } from '../domain/types';
import type { TenancyDependencies } from './dependencies';

export interface InvitationActionInput {
  actor: OrganizationActor;
  invitationId: string;
}

/** Withdraws an open invitation; its link stops working at once. */
export class RevokeInvitation {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork' | 'clock'>) {}

  async execute(input: InvitationActionInput): Promise<void> {
    const { actor } = input;
    if (!isManager(actor.role)) {
      throw new NotPermittedError();
    }
    await this.deps.unitOfWork.run(
      { userId: actor.userId, organizationId: actor.organizationId },
      async (store) => {
        const invitation = await store.invitations.findById(actor.organizationId, input.invitationId);
        if (!invitation) {
          throw new InvitationNotFoundError();
        }
        assertCanGrantRole(actor.role, invitation.role);
        if (!(await store.invitations.revoke(actor.organizationId, invitation.id, this.deps.clock.now()))) {
          throw new InvitationUsedError();
        }
        await store.audit.record({
          organizationId: actor.organizationId,
          action: 'member.invitation_revoke',
          targetType: 'Invitation',
          targetId: invitation.id,
        });
      },
    );
  }
}

/**
 * Sends an open invitation again with a new token and seven more days. The old link stops
 * working, because only the new hash is stored.
 */
export class ResendInvitation {
  constructor(private readonly deps: TenancyDependencies) {}

  async execute(input: InvitationActionInput): Promise<{ expiresAt: Date }> {
    const { actor } = input;
    if (!isManager(actor.role)) {
      throw new NotPermittedError();
    }
    const now = this.deps.clock.now();
    const scope = { userId: actor.userId, organizationId: actor.organizationId };

    const renewed = await this.deps.unitOfWork.run(scope, async (store) => {
      const invitation = await store.invitations.findById(actor.organizationId, input.invitationId);
      if (!invitation) {
        throw new InvitationNotFoundError();
      }
      assertCanGrantRole(actor.role, invitation.role);
      if (invitation.acceptedAt !== null || invitation.revokedAt !== null) {
        throw new InvitationUsedError();
      }
      const secret = this.deps.tokens.create();
      const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
      await store.invitations.renew(actor.organizationId, invitation.id, secret.hash, expiresAt);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'member.invitation_resend',
        targetType: 'Invitation',
        targetId: invitation.id,
      });
      return { invitation, token: secret.token, expiresAt };
    });

    await this.deps.notifier.invitationCreated({
      invitationId: renewed.invitation.id,
      organizationId: renewed.invitation.organizationId,
      email: renewed.invitation.email,
      token: renewed.token,
      role: renewed.invitation.role,
      inviterUserId: actor.userId,
      expiresAt: renewed.expiresAt,
    });
    return { expiresAt: renewed.expiresAt };
  }
}
