import { describe, expect, it } from 'vitest';

import {
  NotPermittedError,
  SetTwoFactorRequirement,
  TwoFactorSetupRequiredError,
  type MemberRole,
} from '../../src';
import { createTestbed, seedOrganization } from '../in-memory-tenancy';

// Architecture 10 and guide step 8.4: owners require a second factor of every member.

function setup() {
  const testbed = createTestbed();
  const seeded = seedOrganization(testbed, [
    { userId: 'owner', email: 'owner@acme.test', role: 'OWNER' },
    { userId: 'admin', email: 'admin@acme.test', role: 'ADMIN' },
  ]);
  const actor = (userId: string, role: MemberRole) => ({
    userId,
    organizationId: seeded.organizationId,
    role,
  });
  return { testbed, organizationId: seeded.organizationId, actor };
}

describe('SetTwoFactorRequirement', () => {
  it('lets an owner with a second factor require it and drop the requirement again', async () => {
    const { testbed, organizationId, actor } = setup();
    const set = new SetTwoFactorRequirement(testbed);

    await expect(
      set.execute({ actor: actor('owner', 'OWNER'), required: true, actorUsesTwoFactor: true }),
    ).resolves.toEqual({ requireTwoFactor: true });
    expect(testbed.unitOfWork.state.twoFactorRequired.has(organizationId)).toBe(true);

    await set.execute({ actor: actor('owner', 'OWNER'), required: false, actorUsesTwoFactor: false });
    expect(testbed.unitOfWork.state.twoFactorRequired.has(organizationId)).toBe(false);
    expect(testbed.unitOfWork.state.audit.map((entry) => entry.action)).toEqual([
      'organization.two_factor_required',
      'organization.two_factor_optional',
    ]);
  });

  it('asks the owner to set up a second factor before requiring it of everybody', async () => {
    const { testbed, organizationId, actor } = setup();

    await expect(
      new SetTwoFactorRequirement(testbed).execute({
        actor: actor('owner', 'OWNER'),
        required: true,
        actorUsesTwoFactor: false,
      }),
    ).rejects.toBeInstanceOf(TwoFactorSetupRequiredError);
    expect(testbed.unitOfWork.state.twoFactorRequired.has(organizationId)).toBe(false);
  });

  it('leaves the decision to owners', async () => {
    const { testbed, actor } = setup();

    await expect(
      new SetTwoFactorRequirement(testbed).execute({
        actor: actor('admin', 'ADMIN'),
        required: true,
        actorUsesTwoFactor: true,
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);
    expect(testbed.unitOfWork.state.audit).toEqual([]);
  });
});
