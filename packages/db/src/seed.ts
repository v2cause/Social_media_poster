// Entry point of `pnpm db:seed` (prisma db seed). Writes the local demo data.
// The root .env is loaded by prisma.config.ts before this file runs.
import { createPrismaClient } from './client';
import { DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from './seed/demo';
import { DEMO_ANALYTICS_DAYS, seedDemoAnalytics } from './seed/demo-analytics';

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('The demo seed never runs in production.');
  }
  const systemUrl = process.env['DATABASE_SYSTEM_URL'];
  const password = process.env['SEED_USER_PASSWORD'];
  if (!systemUrl) {
    throw new Error('DATABASE_SYSTEM_URL is not set.');
  }
  if (!password || password.length < 12) {
    throw new Error('SEED_USER_PASSWORD must be set and at least 12 characters long.');
  }

  // app_system bypasses row-level security, which the seed needs to write several tenants.
  const prisma = createPrismaClient(systemUrl);
  try {
    const demo = await seedDemoData(prisma, password);
    const emails = DEMO_USERS.map((user) => user.email).join(', ');
    process.stdout.write(`Seeded workspace "${DEMO_WORKSPACE_SLUG}" with ${emails}.\n`);
    const analytics = await seedDemoAnalytics(prisma, demo, new Date());
    process.stdout.write(
      analytics.created
        ? `Seeded ${String(analytics.published)} published variants on ${String(analytics.accounts)} mock accounts over ${String(DEMO_ANALYTICS_DAYS)} days.\n`
        : 'The demo analytics were there already; rolled them up again.\n',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown seed error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
