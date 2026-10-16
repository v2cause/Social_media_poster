import {
  AlreadyMemberError,
  EmailNotVerifiedError,
  InvitationNotFoundError,
  InvitationUsedError,
} from '../domain/errors';
import { assertInvitationOpen, assertInvitationRecipient } from '../domain/invitation';
import { seesAllWorkspaces } from '../domain/roles';
import type { MemberRole } from '../domain/types';
import type { TenancyDependencies } from './dependencies';

export interface AcceptInvitationInput {
  user: { id: string; email: string; emailVerified: boolean };
  token: string;
}

/**
 * Turns an invitation into a membership. The signed-in address must match the invited one, and
 * the invitation works once and only within seven days (guide step 1.5).
 */
export class AcceptInvitation {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork' | 'clock' | 'ids' | 'tokens'>) {}

  async execute(
    input: AcceptInvitationInput,
  ): Promise<{ organizationId: string; membershipId: string; role: MemberRole }> {
    if (!input.user.emailVerified) {
      throw new EmailNotVerifiedError();
    }
    const tokenHash = this.deps.tokens.hash(input.token);
    const now = this.deps.clock.now();

    // Only the hash opens the invitation; the organization is not known before.
    const invitation = await this.deps.unitOfWork.run(
      { userId: input.user.id, invitationTokenHash: tokenHash },
      (store) => store.invitations.findByTokenHash(tokenHash),
    );
    if (!invitation) {
      throw new InvitationNotFoundError();
    }
    assertInvitationOpen(invitation, now);
    assertInvitationRecipient(invitation, input.user.email);

    const { organizationId } = invitation;
    return this.deps.unitOfWork.run({ userId: input.user.id, organizationId }, async (store) => {
      if (await store.memberships.findByUser(organizationId, input.user.id)) {
        throw new AlreadyMemberError();
      }
      if (!(await store.invitations.markAccepted(organizationId, invitation.id, now))) {
        throw new InvitationUsedError();
      }
      const membershipId = this.deps.ids.newId();
      await store.memberships.create({
        id: membershipId,
        organizationId,
        userId: input.user.id,
        role: invitation.role,
        workspaceIds: seesAllWorkspaces(invitation.role) ? [] : invitation.workspaceIds,
      });
      await store.audit.record({
        organizationId,
        action: 'member.join',
        targetType: 'Membership',
        targetId: membershipId,
        metadata: { role: invitation.role, invitationId: invitation.id },
      });
      return { organizationId, membershipId, role: invitation.role };
    });
  }
}
