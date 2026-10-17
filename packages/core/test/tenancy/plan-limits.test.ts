import { describe, expect, it } from 'vitest';

import {
  AcceptInvitation,
  CreateWorkspace,
  InviteMember,
  PlanLimitReachedError,
  type OrganizationActor,
} from '../../src';
import { createTestbed, PROFILE, seedOrganization } from '../in-memory-tenancy';

// Guide step 7.4: workspaces and members stay within the plan of the organization. Members and
// open invitations count together; what exists after a downgrade stays, but nothing new comes.

function setup() {
  const testbed = createTestbed();
  const seeded = seedOrganization(testbed, [
    { userId: 'owner', email: 'owner@acme.test', role: 'OWNER' },
    { userId: 'editor', email: 'editor@acme.test', role: 'EDITOR' },
  ]);
  const owner: OrganizationActor = { userId: 'owner', organizationId: seeded.organizationId, role: 'OWNER' };
  return { testbed, ...seeded, owner };
}

describe('the counted limits of the plan in tenancy', () => {
  it('adds workspaces until the plan has no room for another', async () => {
    const { testbed, owner, organizationId } = setup();
    testbed.entitlements.limits.maxWorkspaces = 2;
    const create = new CreateWorkspace(testbed);

    await create.execute({ actor: owner, profile: { ...PROFILE, name: 'Second' } });
    const refused = create.execute({ actor: owner, profile: { ...PROFILE, name: 'Third' } });

    await expect(refused).rejects.toBeInstanceOf(PlanLimitReachedError);
    await expect(refused).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'maxWorkspaces', max: 2 },
    });
    expect(
      [...testbed.unitOfWork.state.workspaces.values()].filter((w) => w.organizationId === organizationId),
    ).toHaveLength(2);
    expect(testbed.unitOfWork.planLocks).toEqual([organizationId, organizationId]);
  });

  it('counts the open invitations with the members, and an invitation to the same address once', async () => {
    const { testbed, owner } = setup();
    testbed.entitlements.limits.maxMembers = 3;
    const invite = new InviteMember(testbed);
    const to = (email: string) => invite.execute({ actor: owner, email, role: 'EDITOR', workspaceIds: [] });

    await to('third@acme.test');
    // A new invitation to the same address replaces the open one.
    await to('third@acme.test');
    await expect(to('fourth@acme.test')).rejects.toMatchObject({
      params: { limit: 'maxMembers', max: 3 },
    });
    expect(testbed.notifier.sent).toHaveLength(2);
  });

  it('lets an invitation from before a downgrade make a member only while the plan has room', async () => {
    const { testbed, owner } = setup();
    await new InviteMember(testbed).execute({
      actor: owner,
      email: 'new@acme.test',
      role: 'EDITOR',
      workspaceIds: [],
    });
    testbed.unitOfWork.addUser('new-user', 'new@acme.test');
    testbed.entitlements.limits.maxMembers = 2;
    const user = { id: 'new-user', email: 'new@acme.test', emailVerified: true };
    const token = testbed.notifier.sent[0]?.token ?? '';

    await expect(new AcceptInvitation(testbed).execute({ user, token })).rejects.toMatchObject({
      params: { limit: 'maxMembers', max: 2 },
    });
    testbed.entitlements.limits.maxMembers = 3;
    await expect(new AcceptInvitation(testbed).execute({ user, token })).resolves.toMatchObject({
      role: 'EDITOR',
    });
  });
});
