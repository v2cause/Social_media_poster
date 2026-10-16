import { NotPermittedError } from '../../shared/domain/errors';
import { LastOwnerError, MemberNotFoundError } from '../domain/errors';
import { assertCanGrantRole, assertCanManageMember, isManager } from '../domain/roles';
import type { MemberRole, Membership, OrganizationActor } from '../domain/types';
import type { TenancyDependencies } from './dependencies';

export interface ChangeMemberRoleInput {
  actor: OrganizationActor;
  membershipId: string;
  role: MemberRole;
}

/** Changes a member's role. The last owner stays owner; admins cannot touch owners. */
export class ChangeMemberRole {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork'>) {}

  async execute(input: ChangeMemberRoleInput): Promise<Membership> {
    const { actor } = input;
    if (!isManager(actor.role)) {
      throw new NotPermittedError();
    }
    const scope = { userId: actor.userId, organizationId: actor.organizationId };

    return this.deps.unitOfWork.run(scope, async (store) => {
      const member = await store.memberships.findById(actor.organizationId, input.membershipId);
      if (!member) {
        throw new MemberNotFoundError();
      }
      if (member.role === input.role) {
        return member;
      }
      assertCanManageMember(actor.role, member.role);
      assertCanGrantRole(actor.role, input.role);
      if (
        member.role === 'OWNER' &&
        (await store.memberships.countOwnersForUpdate(actor.organizationId)) <= 1
      ) {
        throw new LastOwnerError();
      }
      await store.memberships.updateRole(actor.organizationId, member.id, input.role);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'member.role_change',
        targetType: 'Membership',
        targetId: member.id,
        metadata: { from: member.role, to: input.role },
      });
      return { ...member, role: input.role };
    });
  }
}
