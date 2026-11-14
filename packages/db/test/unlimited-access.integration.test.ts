import { randomUUID } from 'node:crypto';

import { UNLIMITED_PLAN_LIMITS } from '@smp/contracts';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaSubscriptionReader,
  PrismaUnlimitedAccess,
  runInSystemScope,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// ADR 0047 on PostgreSQL: the organizations a person owns go on the largest plan with unlimited
// limits, active and without read-only, with an entry in their audit log; an organization that
// Stripe bills stays as it is, and the app reads the result as app_user.

describe('unlimited access on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let app: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;
  const owner = randomUUID();
  const trialOrg = randomUUID();
  const billedOrg = randomUUID();
  const foreignOrg = randomUUID();

  const clients = () => {
    if (!app || !system) {
      throw new Error('not started');
    }
    return { app, system };
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const fixtures = await database.connectAs('app_system');
    try {
      await fixtures.query(
        `INSERT INTO organization (id, name, updated_at)
         VALUES ($1, 'Nordlicht', now()), ($2, 'Bezahlt', now()), ($3, 'Fremd', now())`,
        [trialOrg, billedOrg, foreignOrg],
      );
      await fixtures.query(
        `INSERT INTO users (id, email, name, email_verified, locale, updated_at)
         VALUES ($1, 'mira@nordlicht.test', 'Mira', true, 'de', now()),
                ($2, 'olga@fremd.test', 'Olga', true, 'de', now())`,
        [owner, randomUUID()],
      );
      await fixtures.query(
        `INSERT INTO membership (id, organization_id, user_id, role, updated_at)
         VALUES (gen_random_uuid(), $1, $3, 'OWNER', now()),
                (gen_random_uuid(), $2, $3, 'OWNER', now()),
                (gen_random_uuid(), $4, (SELECT id FROM users WHERE email = 'olga@fremd.test'), 'OWNER', now()),
                (gen_random_uuid(), $4, $3, 'EDITOR', now())`,
        [trialOrg, billedOrg, owner, foreignOrg],
      );
      await fixtures.query(
        `INSERT INTO subscription (id, organization_id, plan_key, status, trial_ends_at, read_only_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'trial', 'TRIALING', now() - interval '1 day', now() - interval '1 day', now()),
                (gen_random_uuid(), $2, 'trial', 'TRIALING', now() + interval '14 days', now() + interval '14 days', now())`,
        [trialOrg, foreignOrg],
      );
      await fixtures.query(
        `INSERT INTO subscription (id, organization_id, plan_key, status, stripe_customer_id,
                                   stripe_subscription_id, billing_started_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'pro', 'ACTIVE', 'cus_1', 'sub_1', now(), now())`,
        [billedOrg],
      );
    } finally {
      await fixtures.end();
    }
    app = createPrismaClient(database.url('app_user'));
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await Promise.all([app?.$disconnect(), system?.$disconnect()]);
    await database?.stop();
  });

  it('finds the organizations a person owns by the address, in any letter case', async () => {
    const access = new PrismaUnlimitedAccess(clients().system);

    const found = await access.ownedOrganizations('Mira@Nordlicht.TEST');

    expect(found?.userId).toBe(owner);
    expect(found?.organizations.map((organization) => organization.id).sort()).toEqual(
      [trialOrg, billedOrg].sort(),
    );
    expect(found?.organizations.find((organization) => organization.id === billedOrg)).toMatchObject({
      billedByStripe: true,
      unlimited: false,
    });
    await expect(access.ownedOrganizations('nobody@nordlicht.test')).resolves.toBeNull();
  });

  it('makes a read-only trial unlimited, records it once and leaves an organization Stripe bills', async () => {
    const access = new PrismaUnlimitedAccess(clients().system);
    const now = new Date();

    await expect(access.grant(trialOrg, 'INC-1', now)).resolves.toBe('granted');
    await expect(access.grant(trialOrg, 'INC-1', now)).resolves.toBe('unchanged');
    await expect(access.grant(billedOrg, 'INC-1', now)).resolves.toBe('billed_by_stripe');

    const subscription = await new PrismaSubscriptionReader(clients().app).find(trialOrg);
    expect(subscription).toMatchObject({
      status: 'ACTIVE',
      trialEndsAt: null,
      readOnlyAt: null,
      limitOverrides: UNLIMITED_PLAN_LIMITS,
      plan: { key: 'agency' },
    });
    const billed = await new PrismaSubscriptionReader(clients().app).find(billedOrg);
    expect(billed).toMatchObject({ status: 'ACTIVE', limitOverrides: null, plan: { key: 'pro' } });

    const entries = await runInSystemScope(() =>
      clients().system.auditLog.findMany({ where: { action: 'billing.unlimited_granted' } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      organizationId: trialOrg,
      actorUserId: null,
      targetType: 'subscription',
      metadata: { plan: 'agency', previousPlan: 'trial', ticket: 'INC-1' },
    });
    const found = await access.ownedOrganizations('mira@nordlicht.test');
    expect(found?.organizations.find((organization) => organization.id === trialOrg)?.unlimited).toBe(true);
  });

  it('creates the subscription of an organization that has none', async () => {
    const access = new PrismaUnlimitedAccess(clients().system);
    const orphan = randomUUID();
    await runInSystemScope(() =>
      clients().system.organization.create({ data: { id: orphan, name: 'Ohne Abo' } }),
    );

    await expect(access.grant(orphan, 'INC-2', new Date())).resolves.toBe('granted');

    await expect(new PrismaSubscriptionReader(clients().app).find(orphan)).resolves.toMatchObject({
      status: 'ACTIVE',
      plan: { key: 'agency' },
    });
  });
});
