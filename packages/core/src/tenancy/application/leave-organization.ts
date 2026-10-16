import { LastOwnerError, MemberNotFoundError } from '../domain/errors';
import type { TenancyDependencies } from './dependencies';

export interface LeaveOrganizationInput {
  actor: { userId: string; organizationId: string };
}

/** Ends the actor's own membership. The last owner cannot leave. */
export class LeaveOrganization {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork'>) {}

  async execute(input: LeaveOrganizationInput): Promise<void> {
    const { actor } = input;
    const scope = { userId: actor.userId, organizationId: actor.organizationId };

    await this.deps.unitOfWork.run(scope, async (store) => {
      const member = await store.memberships.findByUser(actor.organizationId, actor.userId);
      if (!member) {
        throw new MemberNotFoundError();
      }
      if (
        member.role === 'OWNER' &&
        (await store.memberships.countOwnersForUpdate(actor.organizationId)) <= 1
      ) {
        throw new LastOwnerError();
      }
      await store.memberships.delete(actor.organizationId, member.id);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: 'member.leave',
        targetType: 'Membership',
        targetId: member.id,
        metadata: { role: member.role },
      });
    });
  }
}
