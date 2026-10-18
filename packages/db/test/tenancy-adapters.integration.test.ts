import {
  AcceptInvitation,
  ChangeMemberRole,
  CreateOrganization,
  CreateWorkspace,
  EntitlementsService,
  InviteMember,
  LastOwnerError,
  PlanLimitReachedError,
  SetTwoFactorRequirement,
  systemClock,
  uuidV7Ids,
  type InvitationMessage,
  type TenancyDependencies,
  type WorkspaceProfile,
} from '@smp/core';
import { secretTokens } from '@smp/crypto';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  PrismaSubscriptionReader,
  PrismaTenancyUnitOfWork,
  TenancyReadModel,
  type PrismaClient,
} from '../src';

// The Prisma adapters of the tenancy ports against PostgreSQL with row-level security: the use
// cases of the core run unchanged, and every repository method sees only its own tenant.

const profile = (name: string): WorkspaceProfile => ({
  name,
  timezone: 'Europe/Berlin',
  contentLanguage: 'de',
  industry: null,
  targetAudience: null,
  goals: null,
  contentPillars: [],
});

describe('tenancy adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;
  const sent: InvitationMessage[] = [];
  const users = {
    alice: { id: uuidV7Ids.newId(), email: 'alice@example.test', emailVerified: true },
    bob: { id: uuidV7Ids.newId(), email: 'bob@example.test', emailVerified: true },
    carol: { id: uuidV7Ids.newId(), email: 'carol@example.test', emailVerified: true },
  };

  const client = (): PrismaClient => {
    if (!base) {
      throw new Error('database not ready');
    }
    return base;
  };
  const deps = (): TenancyDependencies => ({
    unitOfWork: new PrismaTenancyUnitOfWork(client(), () => ({
      ipAddress: '192.0.2.1',
      userAgent: 'vitest',
    })),
    clock: systemClock,
    ids: uuidV7Ids,
    tokens: secretTokens,
    notifier: {
      invitationCreated: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    },
    entitlements: new EntitlementsService({
      subscriptions: new PrismaSubscriptionReader(client()),
      clock: systemClock,
    }),
  });

  beforeAll(async () => {
    database = await startTestDatabase();
    const fixtures = createPrismaClient(database.url('app_system'));
    try {
      for (const user of Object.values(users)) {
        await fixtures.user.create({
          data: { id: user.id, email: user.email, name: user.email, emailVerified: true },
        });
      }
    } finally {
      await fixtures.$disconnect();
    }
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('runs the tenancy use cases with isolated tenants', async () => {
    const create = new CreateOrganization(deps());
    const acme = await create.execute({ user: users.alice, name: 'Acme', workspace: profile('Marketing') });
    const globex = await create.execute({ user: users.bob, name: 'Globex', workspace: profile('Marketing') });

    // The slug is global (ADR 0010): the second organization gets a suffix, despite RLS hiding
    // the first workspace from it.
    expect(acme.workspaceSlug).toBe('marketing');
    expect(globex.workspaceSlug).toMatch(/^marketing-[a-z2-9]{4}$/);

    const readModel = new TenancyReadModel(client());
    expect(await readModel.resolveWorkspace(users.alice.id, acme.workspaceSlug)).toMatchObject({
      role: 'OWNER',
      organization: { id: acme.organizationId, name: 'Acme' },
    });
    expect(await readModel.resolveWorkspace(users.alice.id, globex.workspaceSlug)).toBeNull();
    expect(await readModel.resolveOrganization(users.alice.id, globex.organizationId)).toBeNull();
    expect(
      (await readModel.listMembers({ userId: users.alice.id, organizationId: acme.organizationId })).map(
        (m) => m.email,
      ),
    ).toEqual(['alice@example.test']);
    // The organization in the scope is a capability: the guards set it only after
    // resolveOrganization or resolveWorkspace found a membership.
    expect(
      (await readModel.listMembers({ userId: users.bob.id, organizationId: globex.organizationId })).map(
        (m) => m.email,
      ),
    ).toEqual(['bob@example.test']);

    // Each organization starts its trial of 14 days with it (guide step 7.1), visible only to itself.
    const subscriptions = new PrismaSubscriptionReader(client());
    const trial = await subscriptions.find(acme.organizationId);
    expect(trial).toMatchObject({ status: 'TRIALING', plan: { key: 'trial' }, stripeCustomerId: null });
    expect(trial?.readOnlyAt).toEqual(trial?.trialEndsAt);
    expect((trial?.trialEndsAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
    expect(await subscriptions.find(globex.organizationId)).toMatchObject({ plan: { key: 'trial' } });
    expect((await subscriptions.plans()).map((plan) => plan.key)).toEqual([
      'trial',
      'starter',
      'pro',
      'agency',
    ]);

    // The audit entries carry actor and origin.
    const system = await database?.connectAs('app_system');
    try {
      const { rows } = (await system?.query<{ action: string; actor_user_id: string; ip_address: string }>(
        'SELECT action, actor_user_id, ip_address FROM audit_log WHERE organization_id = $1 ORDER BY created_at',
        [acme.organizationId],
      )) ?? { rows: [] };
      expect(rows).toEqual([
        { action: 'organization.create', actor_user_id: users.alice.id, ip_address: '192.0.2.1' },
        { action: 'workspace.create', actor_user_id: users.alice.id, ip_address: '192.0.2.1' },
      ]);
    } finally {
      await system?.end();
    }
  });

  it('invites, previews by token and accepts with a workspace restriction', async () => {
    const acme = await new CreateOrganization(deps()).execute({
      user: users.alice,
      name: 'Initech',
      workspace: profile('Brand'),
    });
    const second = await new CreateOrganization(deps()).execute({
      user: users.alice,
      name: 'Initech Two',
      workspace: profile('Other'),
    });
    const owner = { userId: users.alice.id, organizationId: acme.organizationId, role: 'OWNER' as const };

    await new InviteMember(deps()).execute({
      actor: owner,
      email: 'Carol@Example.test',
      role: 'EDITOR',
      workspaceIds: [acme.workspaceId],
    });
    const message = sent.at(-1);
    if (!message) {
      throw new Error('no invitation sent');
    }

    const readModel = new TenancyReadModel(client());
    const preview = await readModel.invitationPreview(secretTokens.hash(message.token));
    expect(preview).toMatchObject({
      organizationName: 'Initech',
      email: 'carol@example.test',
      role: 'EDITOR',
    });
    expect(await readModel.invitationPreview(secretTokens.hash('wrong-token'))).toBeNull();

    const accepted = await new AcceptInvitation(deps()).execute({ user: users.carol, token: message.token });
    expect(accepted).toMatchObject({ organizationId: acme.organizationId, role: 'EDITOR' });

    const memberships = await readModel.membershipsOfUser(users.carol.id);
    expect(memberships).toEqual([
      {
        organizationId: acme.organizationId,
        organizationName: 'Initech',
        role: 'EDITOR',
        workspaces: [{ id: acme.workspaceId, slug: acme.workspaceSlug, name: 'Brand' }],
      },
    ]);
    // The workspace of the other organization stays invisible to the editor.
    expect(await readModel.resolveWorkspace(users.carol.id, second.workspaceSlug)).toBeNull();
    // A second accept fails: the invitation is used.
    await expect(
      new AcceptInvitation(deps()).execute({ user: users.carol, token: message.token }),
    ).rejects.toThrow();
  });

  it('keeps the last owner', async () => {
    const org = await new CreateOrganization(deps()).execute({
      user: users.bob,
      name: 'Solo',
      workspace: profile('Solo Space'),
    });
    const readModel = new TenancyReadModel(client());
    const [ownerMembership] = await readModel.listMembers({
      userId: users.bob.id,
      organizationId: org.organizationId,
    });
    await expect(
      new ChangeMemberRole(deps()).execute({
        actor: { userId: users.bob.id, organizationId: org.organizationId, role: 'OWNER' },
        membershipId: ownerMembership?.id ?? '',
        role: 'ADMIN',
      }),
    ).rejects.toThrow(LastOwnerError);
  });

  it('stores the requirement of a second factor and hands it to the guards (guide step 8.4)', async () => {
    const create = new CreateOrganization(deps());
    const strict = await create.execute({ user: users.carol, name: 'Strict', workspace: profile('Vault') });
    const relaxed = await create.execute({
      user: users.carol,
      name: 'Relaxed',
      workspace: profile('Lounge'),
    });
    const readModel = new TenancyReadModel(client());
    expect(await readModel.resolveOrganization(users.carol.id, strict.organizationId)).toMatchObject({
      organization: { requireTwoFactor: false },
    });

    await new SetTwoFactorRequirement(deps()).execute({
      actor: { userId: users.carol.id, organizationId: strict.organizationId, role: 'OWNER' },
      required: true,
      actorUsesTwoFactor: true,
    });

    expect(await readModel.resolveOrganization(users.carol.id, strict.organizationId)).toMatchObject({
      organization: { id: strict.organizationId, requireTwoFactor: true },
    });
    expect(await readModel.resolveWorkspace(users.carol.id, strict.workspaceSlug)).toMatchObject({
      organization: { requireTwoFactor: true },
    });
    expect(await readModel.resolveOrganization(users.carol.id, relaxed.organizationId)).toMatchObject({
      organization: { requireTwoFactor: false },
    });
  });

  it('keeps workspaces and members within the trial of a new organization', async () => {
    const org = await new CreateOrganization(deps()).execute({
      user: users.carol,
      name: 'Trial GmbH',
      workspace: profile('Trial Space'),
    });
    const owner = { userId: users.carol.id, organizationId: org.organizationId, role: 'OWNER' as const };

    // The trial allows one workspace and three members, the open invitations included.
    await expect(
      new CreateWorkspace(deps()).execute({ actor: owner, profile: profile('Second Space') }),
    ).rejects.toThrow(PlanLimitReachedError);
    const invite = (email: string) =>
      new InviteMember(deps()).execute({ actor: owner, email, role: 'EDITOR', workspaceIds: [] });
    await invite('one@example.test');
    await invite('two@example.test');
    await invite('two@example.test');
    await expect(invite('three@example.test')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'maxMembers', max: 3 },
    });
  });
});
