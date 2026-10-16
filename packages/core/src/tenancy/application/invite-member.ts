import { NotPermittedError } from '../../shared/domain/errors';
import { AlreadyMemberError, InvalidWorkspaceSelectionError } from '../domain/errors';
import { INVITATION_TTL_MS, normalizeEmail } from '../domain/invitation';
import { assertCanGrantRole, isManager, seesAllWorkspaces } from '../domain/roles';
import type { Invitation, MemberRole, OrganizationActor } from '../domain/types';
import type { TenancyDependencies } from './dependencies';

export interface InviteMemberInput {
  actor: OrganizationActor;
  email: string;
  role: MemberRole;
  /** Restricts the new member to these workspaces; empty means all. Ignored for owners and admins. */
  workspaceIds: string[];
}

/**
 * Invites a person by email (guide step 1.5). The token has 32 random bytes; only its hash is
 * stored. The invitation is valid for seven days and replaces open invitations to the address.
 */
export class InviteMember {
  constructor(private readonly deps: TenancyDependencies) {}

  async execute(input: InviteMemberInput): Promise<{ invitationId: string; expiresAt: Date }> {
    const { actor } = input;
    if (!isManager(actor.role)) {
      throw new NotPermittedError();
    }
    assertCanGrantRole(actor.role, input.role);
    const email = normalizeEmail(input.email);
    const workspaceIds = seesAllWorkspaces(input.role) ? [] : [...new Set(input.workspaceIds)];
    const now = this.deps.clock.now();
    const scope = { userId: actor.userId, organizationId: actor.organizationId };

    const { invitation, token } = await this.deps.unitOfWork.run(scope, async (store) => {
      if (await store.memberships.findByEmail(actor.organizationId, email)) {
        throw new AlreadyMemberError();
      }
      if (
        workspaceIds.length > 0 &&
        !(await store.workspaces.allBelongTo(actor.organizationId, workspaceIds))
      ) {
        throw new InvalidWorkspaceSelectionError();
      }
      await store.invitations.revokeOpen(actor.organizationId, email, now);
      const secret = this.deps.tokens.create();
      const created: Invitation = {
        id: this.deps.ids.newId(),
        organizationId: actor.organizationId,
        email,
        role: input.role,
        tokenHash: secret.hash,
        workspaceIds,
        invitedById: actor.userId,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        acceptedAt: null,
        revokedAt: null,
      };
      await store.invitations.create(created);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'member.invite',
        targetType: 'Invitation',
        targetId: created.id,
        metadata: { role: input.role, workspaceIds },
      });
      return { invitation: created, token: secret.token };
    });

    // After the commit: the email must never announce an invitation that was rolled back.
    await this.deps.notifier.invitationCreated({
      invitationId: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email,
      token,
      role: invitation.role,
      inviterUserId: actor.userId,
      expiresAt: invitation.expiresAt,
    });
    return { invitationId: invitation.id, expiresAt: invitation.expiresAt };
  }
}
