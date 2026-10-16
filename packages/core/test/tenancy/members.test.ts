import { describe, expect, it } from 'vitest';

import {
  CannotRemoveSelfError,
  ChangeMemberRole,
  LastOwnerError,
  LeaveOrganization,
  MemberNotFoundError,
  NotPermittedError,
  RemoveMember,
  RoleChangeForbiddenError,
  type MemberRole,
} from '../../src';
import { createTestbed, seedOrganization } from '../in-memory-tenancy';

function setup(owners = 1) {
  const testbed = createTestbed();
  const members: { userId: string; email: string; role: MemberRole }[] = [
    ...Array.from({ length: owners }, (_, index) => ({
      userId: `owner-${String(index + 1)}`,
      email: `owner${String(index + 1)}@acme.test`,
      role: 'OWNER' as const,
    })),
    { userId: 'admin', email: 'admin@acme.test', role: 'ADMIN' },
    { userId: 'editor', email: 'editor@acme.test', role: 'EDITOR' },
  ];
  const seeded = seedOrganization(testbed, members);
  const idOf = (userId: string) => seeded.memberships.find((m) => m.userId === userId)?.id ?? 'missing';
  const actor = (userId: string, role: MemberRole) => ({
    userId,
    organizationId: seeded.organizationId,
    role,
  });
  return { testbed, ...seeded, idOf, actor };
}

describe('ChangeMemberRole', () => {
  it('changes the role and records from and to', async () => {
    const { testbed, idOf, actor } = setup();
    const changed = await new ChangeMemberRole(testbed).execute({
      actor: actor('owner-1', 'OWNER'),
      membershipId: idOf('editor'),
      role: 'ADMIN',
    });
    expect(changed.role).toBe('ADMIN');
    expect(testbed.unitOfWork.state.audit).toEqual([
      expect.objectContaining({ action: 'member.role_change', metadata: { from: 'EDITOR', to: 'ADMIN' } }),
    ]);
  });

  it('does nothing and records nothing when the role stays the same', async () => {
    const { testbed, idOf, actor } = setup();
    await new ChangeMemberRole(testbed).execute({
      actor: actor('admin', 'ADMIN'),
      membershipId: idOf('editor'),
      role: 'EDITOR',
    });
    expect(testbed.unitOfWork.state.audit).toEqual([]);
  });

  it('keeps the last owner', async () => {
    const { testbed, idOf, actor } = setup();
    await expect(
      new ChangeMemberRole(testbed).execute({
        actor: actor('owner-1', 'OWNER'),
        membershipId: idOf('owner-1'),
        role: 'ADMIN',
      }),
    ).rejects.toThrow(LastOwnerError);
  });

  it('lets one of two owners step down', async () => {
    const { testbed, idOf, actor } = setup(2);
    const changed = await new ChangeMemberRole(testbed).execute({
      actor: actor('owner-1', 'OWNER'),
      membershipId: idOf('owner-2'),
      role: 'ADMIN',
    });
    expect(changed.role).toBe('ADMIN');
  });

  it('does not let admins make owners or touch owners', async () => {
    const { testbed, idOf, actor } = setup();
    const change = new ChangeMemberRole(testbed);
    await expect(
      change.execute({ actor: actor('admin', 'ADMIN'), membershipId: idOf('editor'), role: 'OWNER' }),
    ).rejects.toThrow(RoleChangeForbiddenError);
    await expect(
      change.execute({ actor: actor('admin', 'ADMIN'), membershipId: idOf('admin'), role: 'OWNER' }),
    ).rejects.toThrow(RoleChangeForbiddenError);
    await expect(
      change.execute({ actor: actor('admin', 'ADMIN'), membershipId: idOf('owner-1'), role: 'VIEWER' }),
    ).rejects.toThrow(RoleChangeForbiddenError);
  });

  it('refuses editors and unknown members', async () => {
    const { testbed, idOf, actor } = setup();
    const change = new ChangeMemberRole(testbed);
    await expect(
      change.execute({ actor: actor('editor', 'EDITOR'), membershipId: idOf('admin'), role: 'VIEWER' }),
    ).rejects.toThrow(NotPermittedError);
    await expect(
      change.execute({ actor: actor('owner-1', 'OWNER'), membershipId: 'nope', role: 'VIEWER' }),
    ).rejects.toThrow(MemberNotFoundError);
  });
});

describe('RemoveMember', () => {
  it('removes a member and returns the user for cache invalidation', async () => {
    const { testbed, idOf, actor, organizationId } = setup();
    await expect(
      new RemoveMember(testbed).execute({ actor: actor('admin', 'ADMIN'), membershipId: idOf('editor') }),
    ).resolves.toEqual({ userId: 'editor' });
    expect(testbed.unitOfWork.membershipsOf(organizationId).map((m) => m.userId)).not.toContain('editor');
    expect(testbed.unitOfWork.state.audit.at(-1)).toMatchObject({ action: 'member.remove' });
  });

  it('refuses to remove oneself and lets admins not remove owners', async () => {
    const { testbed, idOf, actor } = setup();
    const remove = new RemoveMember(testbed);
    await expect(
      remove.execute({ actor: actor('admin', 'ADMIN'), membershipId: idOf('admin') }),
    ).rejects.toThrow(CannotRemoveSelfError);
    await expect(
      remove.execute({ actor: actor('admin', 'ADMIN'), membershipId: idOf('owner-1') }),
    ).rejects.toThrow(RoleChangeForbiddenError);
  });

  it('lets an owner remove another owner', async () => {
    const { testbed, idOf, actor } = setup(2);
    await expect(
      new RemoveMember(testbed).execute({ actor: actor('owner-1', 'OWNER'), membershipId: idOf('owner-2') }),
    ).resolves.toEqual({ userId: 'owner-2' });
  });
});

describe('LeaveOrganization', () => {
  it('ends the own membership', async () => {
    const { testbed, organizationId } = setup();
    await new LeaveOrganization(testbed).execute({ actor: { userId: 'editor', organizationId } });
    expect(testbed.unitOfWork.membershipsOf(organizationId).map((m) => m.userId)).not.toContain('editor');
    expect(testbed.unitOfWork.state.audit.at(-1)).toMatchObject({ action: 'member.leave' });
  });

  it('keeps the last owner in', async () => {
    const { testbed, organizationId } = setup();
    await expect(
      new LeaveOrganization(testbed).execute({ actor: { userId: 'owner-1', organizationId } }),
    ).rejects.toThrow(LastOwnerError);
  });

  it('lets one of two owners leave', async () => {
    const { testbed, organizationId } = setup(2);
    await expect(
      new LeaveOrganization(testbed).execute({ actor: { userId: 'owner-2', organizationId } }),
    ).resolves.toBeUndefined();
  });

  it('refuses non-members', async () => {
    const { testbed, organizationId } = setup();
    await expect(
      new LeaveOrganization(testbed).execute({ actor: { userId: 'stranger', organizationId } }),
    ).rejects.toThrow(MemberNotFoundError);
  });
});
