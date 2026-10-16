import { describe, expect, it } from 'vitest';

import {
  AcceptInvitation,
  AlreadyMemberError,
  EmailNotVerifiedError,
  INVITATION_TTL_MS,
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationUsedError,
  InviteMember,
  RevokeInvitation,
} from '../../src';
import { createTestbed, seedOrganization } from '../in-memory-tenancy';

async function setup(role: 'EDITOR' | 'ADMIN' = 'EDITOR') {
  const testbed = createTestbed();
  const seeded = seedOrganization(testbed, [{ userId: 'owner', email: 'owner@acme.test', role: 'OWNER' }]);
  const owner = { userId: 'owner', organizationId: seeded.organizationId, role: 'OWNER' as const };
  const { invitationId } = await new InviteMember(testbed).execute({
    actor: owner,
    email: 'new@example.test',
    role,
    workspaceIds: [seeded.workspace.id],
  });
  const token = testbed.notifier.sent[0]?.token ?? '';
  testbed.unitOfWork.addUser('new-user', 'new@example.test');
  return { testbed, ...seeded, owner, invitationId, token, accept: new AcceptInvitation(testbed) };
}

const newUser = { id: 'new-user', email: 'NEW@example.test', emailVerified: true };

describe('AcceptInvitation', () => {
  it('creates the membership with role and workspace restriction and uses the invitation up', async () => {
    const { testbed, accept, token, invitationId, organizationId, workspace } = await setup();
    const result = await accept.execute({ user: newUser, token });

    expect(result).toMatchObject({ organizationId, role: 'EDITOR' });
    expect(testbed.unitOfWork.membershipsOf(organizationId)).toContainEqual(
      expect.objectContaining({ userId: 'new-user', role: 'EDITOR', workspaceIds: [workspace.id] }),
    );
    expect(testbed.unitOfWork.state.invitations.get(invitationId)?.acceptedAt).toEqual(testbed.clock.now());
    expect(testbed.unitOfWork.state.audit.at(-1)).toMatchObject({
      action: 'member.join',
      scopeUserId: 'new-user',
    });
    // First the token hash alone, then the organization of the invitation.
    expect(testbed.unitOfWork.scopes.slice(-2)).toEqual([
      { userId: 'new-user', invitationTokenHash: 'sha256(token-1)' },
      { userId: 'new-user', organizationId },
    ]);
  });

  it('works only once', async () => {
    const { accept, token } = await setup();
    await accept.execute({ user: newUser, token });
    await expect(accept.execute({ user: newUser, token })).rejects.toThrow(InvitationUsedError);
  });

  it('refuses another address', async () => {
    const { accept, token, testbed } = await setup();
    testbed.unitOfWork.addUser('other', 'other@example.test');
    await expect(
      accept.execute({ user: { id: 'other', email: 'other@example.test', emailVerified: true }, token }),
    ).rejects.toThrow(InvitationEmailMismatchError);
  });

  it('refuses expired, revoked and unknown invitations', async () => {
    const expired = await setup();
    expired.testbed.clock.advance(INVITATION_TTL_MS);
    await expect(expired.accept.execute({ user: newUser, token: expired.token })).rejects.toThrow(
      InvitationExpiredError,
    );

    const revoked = await setup();
    await new RevokeInvitation(revoked.testbed).execute({
      actor: revoked.owner,
      invitationId: revoked.invitationId,
    });
    await expect(revoked.accept.execute({ user: newUser, token: revoked.token })).rejects.toThrow(
      InvitationUsedError,
    );

    await expect(revoked.accept.execute({ user: newUser, token: 'guessed' })).rejects.toThrow(
      InvitationNotFoundError,
    );
  });

  it('refuses existing members and unverified addresses', async () => {
    const { accept, token, testbed, organizationId } = await setup();
    testbed.unitOfWork.seed({
      organization: { id: organizationId, name: 'Acme' },
      memberships: [{ id: 'm-x', organizationId, userId: 'new-user', role: 'VIEWER', workspaceIds: [] }],
    });
    await expect(accept.execute({ user: newUser, token })).rejects.toThrow(AlreadyMemberError);
    await expect(accept.execute({ user: { ...newUser, emailVerified: false }, token })).rejects.toThrow(
      EmailNotVerifiedError,
    );
  });

  it('drops the workspace restriction for admins', async () => {
    const { accept, token, testbed, organizationId } = await setup('ADMIN');
    await accept.execute({ user: newUser, token });
    expect(testbed.unitOfWork.membershipsOf(organizationId)).toContainEqual(
      expect.objectContaining({ userId: 'new-user', role: 'ADMIN', workspaceIds: [] }),
    );
  });
});
