import { describe, expect, it } from 'vitest';

import {
  CreateOrganization,
  CreateWorkspace,
  EmailNotVerifiedError,
  NotPermittedError,
  OrganizationLimitReachedError,
  SlugUnavailableError,
} from '../../src';
import { createTestbed, PROFILE, seedOrganization } from '../in-memory-tenancy';

const user = { id: 'user-1', emailVerified: true };

describe('CreateOrganization', () => {
  it('creates organization, owner membership, workspace and settings in one scope', async () => {
    const testbed = createTestbed();
    const result = await new CreateOrganization(testbed).execute({
      user,
      name: 'Acme GmbH',
      workspace: PROFILE,
    });

    const { state, scopes } = testbed.unitOfWork;
    expect(result.workspaceSlug).toBe('marketing-sales');
    expect(state.organizations.get(result.organizationId)).toEqual({
      id: result.organizationId,
      name: 'Acme GmbH',
    });
    expect(testbed.unitOfWork.membershipsOf(result.organizationId)).toEqual([
      expect.objectContaining({ userId: 'user-1', role: 'OWNER', workspaceIds: [] }),
    ]);
    expect(state.workspaces.get(result.workspaceId)).toMatchObject({
      organizationId: result.organizationId,
      ...PROFILE,
    });
    expect(state.settings.get(result.workspaceId)).toMatchObject({
      dryRun: false,
      missedWindowBehavior: 'FAIL',
    });
    expect(state.audit.map((entry) => entry.action)).toEqual(['organization.create', 'workspace.create']);
    // The trial of 14 days starts with the organization (guide step 7.1).
    expect(state.trials.get(result.organizationId)).toMatchObject({
      trialEndsAt: new Date('2026-10-30T09:00:00.000Z'),
      readOnlyAt: new Date('2026-10-30T09:00:00.000Z'),
    });
    expect(scopes).toEqual([
      { userId: 'user-1', organizationId: result.organizationId, workspaceId: result.workspaceId },
    ]);
  });

  it('refuses users whose email address is not verified', async () => {
    const testbed = createTestbed();
    await expect(
      new CreateOrganization(testbed).execute({
        user: { id: 'user-1', emailVerified: false },
        name: 'Acme',
        workspace: PROFILE,
      }),
    ).rejects.toThrow(EmailNotVerifiedError);
    expect(testbed.unitOfWork.state.organizations.size).toBe(0);
  });

  it('adds a suffix when the slug is taken in another organization', async () => {
    const testbed = createTestbed();
    testbed.unitOfWork.foreignSlugs.add('marketing-sales');
    const result = await new CreateOrganization(testbed).execute({ user, name: 'Acme', workspace: PROFILE });
    expect(result.workspaceSlug).toBe('marketing-sales-s1');
  });

  it('lets a user create three organizations in 30 days, one at a time', async () => {
    const testbed = createTestbed();
    // Memberships in other organizations do not count, and neither do older ones.
    seedOrganization(testbed, [
      { userId: 'user-1', email: 'u1@acme.test', role: 'EDITOR' },
      { userId: 'user-2', email: 'u2@acme.test', role: 'OWNER' },
    ]);
    const create = (id = 'user-1') =>
      new CreateOrganization(testbed).execute({ user: { ...user, id }, name: 'Acme', workspace: PROFILE });
    for (const day of [0, 10, 20]) {
      testbed.clock.current = new Date(Date.parse('2026-10-16T09:00:00Z') + day * 24 * 60 * 60 * 1000);
      await create();
    }

    await expect(create()).rejects.toThrow(OrganizationLimitReachedError);
    expect(testbed.unitOfWork.state.organizations.size).toBe(4);
    expect(testbed.unitOfWork.newOrganizationLocks).toEqual(['user-1', 'user-1', 'user-1', 'user-1']);
    await expect(create('user-2')).resolves.toMatchObject({ workspaceSlug: expect.any(String) as unknown });
    // Once the first one is more than 30 days old, the user may create the next.
    testbed.clock.current = new Date('2026-11-15T09:00:01Z');
    await expect(create()).resolves.toMatchObject({ workspaceSlug: expect.any(String) as unknown });
  });

  it('gives up after five taken slugs and leaves nothing behind', async () => {
    const testbed = createTestbed();
    for (const slug of [
      'marketing-sales',
      'marketing-sales-s1',
      'marketing-sales-s2',
      'marketing-sales-s3',
      'marketing-sales-s4',
    ]) {
      testbed.unitOfWork.foreignSlugs.add(slug);
    }
    await expect(
      new CreateOrganization(testbed).execute({ user, name: 'Acme', workspace: PROFILE }),
    ).rejects.toThrow(SlugUnavailableError);
    expect(testbed.unitOfWork.state.organizations.size).toBe(0);
    expect(testbed.unitOfWork.state.memberships.size).toBe(0);
  });
});

describe('CreateWorkspace', () => {
  it('lets owners and admins add a workspace with settings', async () => {
    const testbed = createTestbed();
    const { organizationId } = seedOrganization(testbed, [
      { userId: 'admin', email: 'admin@acme.test', role: 'ADMIN' },
    ]);

    const result = await new CreateWorkspace(testbed).execute({
      actor: { userId: 'admin', organizationId, role: 'ADMIN' },
      profile: { ...PROFILE, name: 'Employer Branding' },
    });

    expect(result.workspaceSlug).toBe('employer-branding');
    expect(testbed.unitOfWork.state.settings.has(result.workspaceId)).toBe(true);
    expect(testbed.unitOfWork.state.audit).toEqual([
      expect.objectContaining({ action: 'workspace.create', workspaceId: result.workspaceId }),
    ]);
  });

  it('refuses editors and viewers', async () => {
    const testbed = createTestbed();
    const { organizationId } = seedOrganization(testbed, [
      { userId: 'editor', email: 'e@acme.test', role: 'EDITOR' },
    ]);
    await expect(
      new CreateWorkspace(testbed).execute({
        actor: { userId: 'editor', organizationId, role: 'EDITOR' },
        profile: PROFILE,
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});
