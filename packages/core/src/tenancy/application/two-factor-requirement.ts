import { NotPermittedError } from '../../shared/domain/errors';
import { TwoFactorSetupRequiredError } from '../domain/errors';
import type { OrganizationActor } from '../domain/types';
import type { TenancyDependencies } from './dependencies';

// Architecture 10 and guide step 8.4: an owner requires a second factor of every member of the
// organization. From then on, members without one reach no route of the organization until they
// set one up; the API checks it with every request. The audit log records each change.

export interface SetTwoFactorRequirementInput {
  actor: OrganizationActor;
  required: boolean;
  /** Whether the acting owner signs in with a second factor; nobody requires what they lack. */
  actorUsesTwoFactor: boolean;
}

export class SetTwoFactorRequirement {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork'>) {}

  async execute(input: SetTwoFactorRequirementInput): Promise<{ requireTwoFactor: boolean }> {
    const { actor, required } = input;
    if (actor.role !== 'OWNER') {
      throw new NotPermittedError();
    }
    if (required && !input.actorUsesTwoFactor) {
      throw new TwoFactorSetupRequiredError();
    }
    const scope = { userId: actor.userId, organizationId: actor.organizationId };
    await this.deps.unitOfWork.run(scope, async (store) => {
      await store.organizations.setTwoFactorRequired(actor.organizationId, required);
      await store.audit.record({
        organizationId: actor.organizationId,
        action: required ? 'organization.two_factor_required' : 'organization.two_factor_optional',
        targetType: 'Organization',
        targetId: actor.organizationId,
      });
    });
    return { requireTwoFactor: required };
  }
}
