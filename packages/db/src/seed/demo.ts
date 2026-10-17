import { hashPassword } from 'better-auth/crypto';
import { uuidv7 } from 'uuidv7';

import type { PrismaClient } from '../generated/prisma/client';
import type { MemberRole } from '../generated/prisma/enums';

// Local demo data (architecture 16): one organization, one workspace and a user per role.
// Every user signs in with the same password from SEED_USER_PASSWORD.

export const DEMO_WORKSPACE_SLUG = 'demo';

export const DEMO_USERS: ReadonlyArray<{ email: string; name: string; role: MemberRole }> = [
  { email: 'owner@demo.local', name: 'Demo Owner', role: 'OWNER' },
  { email: 'admin@demo.local', name: 'Demo Admin', role: 'ADMIN' },
  { email: 'editor@demo.local', name: 'Demo Editor', role: 'EDITOR' },
  { email: 'viewer@demo.local', name: 'Demo Viewer', role: 'VIEWER' },
];

/**
 * A platform admin without a membership, for the switches under /admin (guide step 6.1). Only
 * local demo data: platform operators set the flag by hand everywhere else.
 */
export const DEMO_PLATFORM_ADMIN = { email: 'platform@demo.local', name: 'Demo Platform Admin' } as const;

// Better Auth stores email and password logins as an account with this provider id.
const CREDENTIAL_PROVIDER = 'credential';

export interface DemoSeedResult {
  organizationId: string;
  workspaceId: string;
  userIds: Record<string, string>;
}

/**
 * Creates the demo data or completes it; running it twice changes nothing. Needs a client that
 * bypasses row-level security (app_system), because it writes into several tenants' tables.
 */
export async function seedDemoData(prisma: PrismaClient, password: string): Promise<DemoSeedResult> {
  const passwordHash = await hashPassword(password);

  const userIds: Record<string, string> = {};
  for (const demoUser of [...DEMO_USERS, DEMO_PLATFORM_ADMIN]) {
    const platformAdmin = demoUser.email === DEMO_PLATFORM_ADMIN.email;
    const user = await prisma.user.upsert({
      where: { email: demoUser.email },
      create: {
        id: uuidv7(),
        email: demoUser.email,
        name: demoUser.name,
        emailVerified: true,
        isPlatformAdmin: platformAdmin,
      },
      update: {},
    });
    userIds[demoUser.email] = user.id;

    const credential = await prisma.account.findFirst({
      where: { userId: user.id, providerId: CREDENTIAL_PROVIDER },
    });
    if (!credential) {
      await prisma.account.create({
        data: {
          id: uuidv7(),
          userId: user.id,
          accountId: user.id,
          providerId: CREDENTIAL_PROVIDER,
          password: passwordHash,
        },
      });
    }
  }

  const existing = await prisma.workspace.findUnique({ where: { slug: DEMO_WORKSPACE_SLUG } });
  const workspace =
    existing ??
    (await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({ data: { name: 'Demo GmbH' } });
      return tx.workspace.create({
        data: {
          organizationId: organization.id,
          slug: DEMO_WORKSPACE_SLUG,
          name: 'Demo',
          timezone: 'Europe/Berlin',
          contentLanguage: 'de',
          industry: 'Software',
          targetAudience: 'Marketing-Teams im Mittelstand',
          contentPillars: ['Produkt', 'Einblicke', 'Tipps'],
          settings: { create: {} },
        },
      });
    }));

  for (const demoUser of DEMO_USERS) {
    const userId = userIds[demoUser.email];
    if (!userId) {
      throw new Error(`Seed user ${demoUser.email} was not created`);
    }
    await prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: workspace.organizationId, userId } },
      create: { organizationId: workspace.organizationId, userId, role: demoUser.role },
      update: { role: demoUser.role },
    });
  }

  return { organizationId: workspace.organizationId, workspaceId: workspace.id, userIds };
}
