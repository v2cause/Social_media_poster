import { NotPermittedError } from '../../shared/domain/errors';
import { CannotRemoveSelfError, LastOwnerError, MemberNotFoundError } from '../domain/errors';
import { assertCanManageMember, isManager } from '../domain/roles';
import type { OrganizationActor } from '../domain/types';
import type { TenancyDependencies } from './dependencies';

export interface RemoveMemberInput {
  actor: OrganizationActor;
  membershipId: string;
}

/** Removes another member. Members leave on their own with LeaveOrganization. */
export class RemoveMember {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork'>) {}

  async execute(input: RemoveMemberInput): Promise<{ userId: string }> {
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
      if (member.userId === actor.userId) {
        throw new CannotRemoveSelfError();
      }
      assertCanManageMember(actor.role, member.role);
      if (
        member.role === 'OWNER' &&
        (await store.memberships.countOwnersForUpdate(actor.organizationId)) <= 1
      ) {
        throw new LastOwnerError();
      }
      await store.memberships.delete(actor.organizationId, member.id);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'member.remove',
        targetType: 'Membership',
        targetId: member.id,
        metadata: { role: member.role },
      });
      return { userId: member.userId };
    });
  }
}
