import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, type PrismaClient } from '../src';
import { DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '../src/seed/demo';
import { startTestDatabase, type TestDatabase } from './support/database';

describe('demo seed', () => {
  let database: TestDatabase | undefined;
  let prisma: PrismaClient | undefined;

  const client = (): PrismaClient => {
    if (!prisma) {
      throw new Error('Prisma client is not connected');
    }
    return prisma;
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    prisma = createPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.stop();
  });

  it('creates one organization, the demo workspace and a user per role', async () => {
    const result = await seedDemoData(client(), 'test-seed-password');

    const workspace = await client().workspace.findUniqueOrThrow({
      where: { slug: DEMO_WORKSPACE_SLUG },
      include: { settings: true },
    });
    expect(workspace.organizationId).toBe(result.organizationId);
    expect(workspace.settings).not.toBeNull();

    const memberships = await client().membership.findMany({
      where: { organizationId: result.organizationId },
      include: { user: true },
    });
    expect(memberships.map((m) => [m.user.email, m.role]).sort()).toEqual(
      DEMO_USERS.map((u) => [u.email, u.role]).sort(),
    );
    expect(memberships.every((m) => m.user.emailVerified)).toBe(true);
  });

  it('stores a password login per user and never the plain password', async () => {
    const accounts = await client().account.findMany({ where: { providerId: 'credential' } });

    expect(accounts).toHaveLength(DEMO_USERS.length);
    expect(accounts.every((a) => a.password && !a.password.includes('test-seed-password'))).toBe(true);
  });

  it('changes nothing when it runs again', async () => {
    await seedDemoData(client(), 'test-seed-password');

    expect(await client().organization.count()).toBe(1);
    expect(await client().user.count()).toBe(DEMO_USERS.length);
    expect(await client().membership.count()).toBe(DEMO_USERS.length);
    expect(await client().account.count()).toBe(DEMO_USERS.length);
  });
});
