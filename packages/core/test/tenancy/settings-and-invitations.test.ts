import { describe, expect, it } from 'vitest';

import {
  INVITATION_TTL_MS,
  InvitationNotFoundError,
  InvitationUsedError,
  InviteMember,
  NotPermittedError,
  ResendInvitation,
  RevokeInvitation,
  RoleChangeForbiddenError,
  UpdateWorkspaceSettings,
  WorkspaceNotFoundError,
  type MemberRole,
} from '../../src';
import { createTestbed, seedOrganization } from '../in-memory-tenancy';

function setup() {
  const testbed = createTestbed();
  const seeded = seedOrganization(testbed, [
    { userId: 'owner', email: 'owner@acme.test', role: 'OWNER' },
    { userId: 'admin', email: 'admin@acme.test', role: 'ADMIN' },
    { userId: 'editor', email: 'editor@acme.test', role: 'EDITOR' },
  ]);
  const actor = (userId: string, role: MemberRole) => ({
    userId,
    organizationId: seeded.organizationId,
    role,
  });
  return { testbed, ...seeded, actor };
}

describe('UpdateWorkspaceSettings', () => {
  it('updates the settings and records the changed fields', async () => {
    const { testbed, actor, workspace } = setup();
    const settings = await new UpdateWorkspaceSettings(testbed).execute({
      actor: { ...actor('admin', 'ADMIN'), workspaceId: workspace.id },
      patch: { missedWindowBehavior: 'POST_ANYWAY', dryRun: true },
    });
    expect(settings).toMatchObject({ dryRun: true, missedWindowBehavior: 'POST_ANYWAY' });
    expect(testbed.unitOfWork.state.audit).toEqual([
      expect.objectContaining({
        action: 'workspace.settings_update',
        metadata: { fields: ['dryRun', 'missedWindowBehavior'] },
      }),
    ]);
  });

  it('refuses editors and unknown workspaces', async () => {
    const { testbed, actor, workspace } = setup();
    const update = new UpdateWorkspaceSettings(testbed);
    await expect(
      update.execute({
        actor: { ...actor('editor', 'EDITOR'), workspaceId: workspace.id },
        patch: { dryRun: true },
      }),
    ).rejects.toThrow(NotPermittedError);
    await expect(
      update.execute({
        actor: { ...actor('admin', 'ADMIN'), workspaceId: 'ws-unknown' },
        patch: { dryRun: true },
      }),
    ).rejects.toThrow(WorkspaceNotFoundError);
  });
});

describe('RevokeInvitation and ResendInvitation', () => {
  async function invited(role: MemberRole = 'VIEWER') {
    const context = setup();
    const { invitationId } = await new InviteMember(context.testbed).execute({
      actor: context.actor('owner', 'OWNER'),
      email: 'guest@example.test',
      role,
      workspaceIds: [],
    });
    return { ...context, invitationId };
  }

  it('revokes an open invitation once', async () => {
    const { testbed, actor, invitationId } = await invited();
    const revoke = new RevokeInvitation(testbed);
    await revoke.execute({ actor: actor('admin', 'ADMIN'), invitationId });
    expect(testbed.unitOfWork.state.invitations.get(invitationId)?.revokedAt).toEqual(testbed.clock.now());
    await expect(revoke.execute({ actor: actor('admin', 'ADMIN'), invitationId })).rejects.toThrow(
      InvitationUsedError,
    );
  });

  it('lets admins not revoke owner invitations', async () => {
    const { testbed, actor, invitationId } = await invited('OWNER');
    await expect(
      new RevokeInvitation(testbed).execute({ actor: actor('admin', 'ADMIN'), invitationId }),
    ).rejects.toThrow(RoleChangeForbiddenError);
  });

  it('resends with a new token and a new expiry, which ends the old link', async () => {
    const { testbed, actor, invitationId } = await invited();
    testbed.clock.advance(3 * 24 * 60 * 60 * 1000);
    const { expiresAt } = await new ResendInvitation(testbed).execute({
      actor: actor('admin', 'ADMIN'),
      invitationId,
    });

    expect(expiresAt.getTime() - testbed.clock.now().getTime()).toBe(INVITATION_TTL_MS);
    expect(testbed.unitOfWork.state.invitations.get(invitationId)?.tokenHash).toBe('sha256(token-2)');
    expect(testbed.notifier.sent.map((message) => message.token)).toEqual(['token-1', 'token-2']);
    expect(testbed.unitOfWork.state.audit.at(-1)).toMatchObject({ action: 'member.invitation_resend' });
  });

  it('does not resend used or unknown invitations', async () => {
    const { testbed, actor, invitationId } = await invited();
    await new RevokeInvitation(testbed).execute({ actor: actor('owner', 'OWNER'), invitationId });
    const resend = new ResendInvitation(testbed);
    await expect(resend.execute({ actor: actor('owner', 'OWNER'), invitationId })).rejects.toThrow(
      InvitationUsedError,
    );
    await expect(resend.execute({ actor: actor('owner', 'OWNER'), invitationId: 'nope' })).rejects.toThrow(
      InvitationNotFoundError,
    );
    await expect(resend.execute({ actor: actor('editor', 'EDITOR'), invitationId })).rejects.toThrow(
      NotPermittedError,
    );
  });
});
