import { describe, expect, it } from 'vitest';

import {
  AlreadyMemberError,
  INVITATION_TTL_MS,
  InvalidWorkspaceSelectionError,
  InviteMember,
  NotPermittedError,
  RoleChangeForbiddenError,
  type OrganizationActor,
} from '../../src';
import { createTestbed, seedOrganization } from '../in-memory-tenancy';

function setup() {
  const testbed = createTestbed();
  const seeded = seedOrganization(testbed, [
    { userId: 'owner', email: 'owner@acme.test', role: 'OWNER' },
    { userId: 'admin', email: 'admin@acme.test', role: 'ADMIN' },
    { userId: 'editor', email: 'editor@acme.test', role: 'EDITOR' },
  ]);
  const actor = (userId: string, role: OrganizationActor['role']): OrganizationActor => ({
    userId,
    organizationId: seeded.organizationId,
    role,
  });
  return { testbed, ...seeded, actor, invite: new InviteMember(testbed) };
}

describe('InviteMember', () => {
  it('stores only the token hash, expires after seven days and sends the token after the commit', async () => {
    const { testbed, invite, actor, workspace } = setup();
    const result = await invite.execute({
      actor: actor('admin', 'ADMIN'),
      email: '  New.Person@Example.TEST ',
      role: 'EDITOR',
      workspaceIds: [workspace.id, workspace.id],
    });

    const stored = testbed.unitOfWork.state.invitations.get(result.invitationId);
    expect(stored).toMatchObject({
      email: 'new.person@example.test',
      role: 'EDITOR',
      tokenHash: 'sha256(token-1)',
      workspaceIds: [workspace.id],
      invitedById: 'admin',
      acceptedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain('"token-1"');
    expect(result.expiresAt.getTime() - testbed.clock.now().getTime()).toBe(INVITATION_TTL_MS);
    expect(testbed.notifier.sent).toEqual([
      expect.objectContaining({
        invitationId: result.invitationId,
        email: 'new.person@example.test',
        token: 'token-1',
      }),
    ]);
    expect(testbed.unitOfWork.state.audit).toEqual([
      expect.objectContaining({
        action: 'member.invite',
        targetId: result.invitationId,
        metadata: { role: 'EDITOR', workspaceIds: [workspace.id] },
      }),
    ]);
  });

  it('replaces open invitations to the same address', async () => {
    const { testbed, invite, actor } = setup();
    const first = await invite.execute({
      actor: actor('owner', 'OWNER'),
      email: 'x@example.test',
      role: 'VIEWER',
      workspaceIds: [],
    });
    await invite.execute({
      actor: actor('owner', 'OWNER'),
      email: 'X@example.test',
      role: 'EDITOR',
      workspaceIds: [],
    });
    expect(testbed.unitOfWork.state.invitations.get(first.invitationId)?.revokedAt).toEqual(
      testbed.clock.now(),
    );
  });

  it('ignores a workspace restriction for admins', async () => {
    const { testbed, invite, actor, workspace } = setup();
    const result = await invite.execute({
      actor: actor('owner', 'OWNER'),
      email: 'a@example.test',
      role: 'ADMIN',
      workspaceIds: [workspace.id],
    });
    expect(testbed.unitOfWork.state.invitations.get(result.invitationId)?.workspaceIds).toEqual([]);
  });

  it('lets only owners invite owners', async () => {
    const { invite, actor } = setup();
    await expect(
      invite.execute({
        actor: actor('admin', 'ADMIN'),
        email: 'boss@example.test',
        role: 'OWNER',
        workspaceIds: [],
      }),
    ).rejects.toThrow(RoleChangeForbiddenError);
    await expect(
      invite.execute({
        actor: actor('owner', 'OWNER'),
        email: 'boss@example.test',
        role: 'OWNER',
        workspaceIds: [],
      }),
    ).resolves.toBeDefined();
  });

  it('refuses editors', async () => {
    const { invite, actor } = setup();
    await expect(
      invite.execute({
        actor: actor('editor', 'EDITOR'),
        email: 'x@example.test',
        role: 'VIEWER',
        workspaceIds: [],
      }),
    ).rejects.toThrow(NotPermittedError);
  });

  it('refuses existing members and foreign workspaces without sending anything', async () => {
    const { testbed, invite, actor } = setup();
    await expect(
      invite.execute({
        actor: actor('owner', 'OWNER'),
        email: 'EDITOR@acme.test',
        role: 'VIEWER',
        workspaceIds: [],
      }),
    ).rejects.toThrow(AlreadyMemberError);
    await expect(
      invite.execute({
        actor: actor('owner', 'OWNER'),
        email: 'x@example.test',
        role: 'VIEWER',
        workspaceIds: ['ws-other'],
      }),
    ).rejects.toThrow(InvalidWorkspaceSelectionError);
    expect(testbed.notifier.sent).toEqual([]);
    expect(testbed.unitOfWork.state.invitations.size).toBe(0);
  });
});
