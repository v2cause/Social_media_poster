import { daysBefore, startOfLocalDay } from '@smp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { createPrismaClient, type PrismaClient } from '../src';
import { DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '../src/seed/demo';
import { DEMO_ANALYTICS_DAYS, seedDemoAnalytics } from '../src/seed/demo-analytics';

/** Noon in Berlin; the account numbers of yesterday came in at 03:15. */
const NOW = new Date('2026-10-17T10:00:00Z');
const TODAY = '2026-10-17';

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

  it('seeds 90 days of analytics on four mock accounts without tokens', async () => {
    const demo = await seedDemoData(client(), 'test-seed-password');
    const result = await seedDemoAnalytics(client(), demo, NOW);
    expect(result).toMatchObject({ created: true, accounts: 4 });

    const connections = await client().socialConnection.findMany({ include: { accounts: true } });
    expect(connections.map((connection) => connection.platform).sort()).toEqual([
      'FACEBOOK',
      'INSTAGRAM',
      'LINKEDIN',
      'X',
    ]);
    for (const connection of connections) {
      expect(connection).toMatchObject({
        workspaceId: demo.workspaceId,
        method: 'MOCK',
        status: 'ACTIVE',
        accessTokenSealed: null,
        refreshTokenSealed: null,
      });
      expect(connection.scopes.length).toBeGreaterThan(0);
      expect(connection.accounts).toHaveLength(1);
    }

    const variants = await client().postVariant.findMany({
      where: { status: 'PUBLISHED' },
      include: { snapshots: { orderBy: { capturedAt: 'asc' } }, latestMetrics: true },
    });
    expect(variants).toHaveLength(result.published);
    expect(variants.length).toBeGreaterThan(100);
    const firstDay = startOfLocalDay(daysBefore(TODAY, DEMO_ANALYTICS_DAYS - 1), 'Europe/Berlin');
    for (const variant of variants) {
      expect(variant).toMatchObject({ status: 'PUBLISHED', metricsNextAt: null, isDryRun: false });
      const publishedAt = variant.publishedAt ?? NOW;
      expect(publishedAt.getTime()).toBeGreaterThanOrEqual(firstDay.getTime());
      expect(publishedAt.getTime()).toBeLessThan(NOW.getTime());
      expect(variant.snapshots).toHaveLength(variant.metricsStep);
      // The counters only grow along the cascade, and the latest numbers are the last snapshot.
      const impressions = variant.snapshots.map((snapshot) => snapshot.impressions ?? 0);
      expect(impressions).toEqual([...impressions].sort((a, b) => a - b));
      expect(variant.snapshots.every((snapshot) => snapshot.capturedAt < NOW)).toBe(true);
      expect(variant.latestMetrics?.impressions ?? null).toBe(variant.snapshots.at(-1)?.impressions ?? null);
    }
    // What a platform does not report stays null, so the views can show "n. v." instead of 0.
    const snapshotsOf = (platform: string) =>
      variants.filter((variant) => variant.platform === platform).flatMap((variant) => variant.snapshots);
    expect(snapshotsOf('X').every((snapshot) => snapshot.reach === null && snapshot.saves === null)).toBe(
      true,
    );
    expect(
      snapshotsOf('INSTAGRAM').every((snapshot) => snapshot.clicks === null && snapshot.saves !== null),
    ).toBe(true);
    expect(variants.filter((variant) => variant.externalDeletedAt !== null)).toHaveLength(2);
    // The style breakdown has several styles and posts without one.
    const posts = await client().post.findMany({ select: { styleId: true } });
    expect(new Set(posts.map((post) => post.styleId)).size).toBeGreaterThan(4);

    // Around today: planned posts to come, drafts, and two that went wrong.
    const others = await client().postVariant.groupBy({
      by: ['status'],
      where: { status: { not: 'PUBLISHED' } },
      _count: { _all: true },
      _min: { scheduledAt: true },
    });
    expect(Object.fromEntries(others.map((group) => [group.status, group._count._all]))).toEqual({
      SCHEDULED: 5,
      DRAFT: 3,
      FAILED: 1,
      NEEDS_ATTENTION: 1,
    });
    const planned = others.find((group) => group.status === 'SCHEDULED')?._min.scheduledAt;
    expect(planned && planned > NOW).toBe(true);
  });

  it('rolls the days of the demo accounts up in the time zone of the workspace', async () => {
    const accountDays = await client().accountMetricSnapshot.groupBy({
      by: ['socialAccountId'],
      _count: { _all: true },
      _min: { day: true },
      _max: { day: true },
    });
    expect(accountDays).toHaveLength(4);
    // The 90 days end today; the numbers of today come in tomorrow morning.
    for (const group of accountDays) {
      expect(group._count._all).toBe(DEMO_ANALYTICS_DAYS - 1);
      expect(group._min.day?.toISOString().slice(0, 10)).toBe(daysBefore(TODAY, DEMO_ANALYTICS_DAYS - 1));
      expect(group._max.day?.toISOString().slice(0, 10)).toBe(daysBefore(TODAY, 1));
    }

    const daily = await client().analyticsDaily.findMany();
    const published = await client().postVariant.count({ where: { status: 'PUBLISHED' } });
    expect(daily.reduce((sum, row) => sum + row.postsPublished, 0)).toBe(published);
    for (const group of accountDays) {
      const rows = daily.filter((row) => row.socialAccountId === group.socialAccountId);
      expect(rows.length).toBeGreaterThanOrEqual(DEMO_ANALYTICS_DAYS - 1);
      expect(rows.length).toBeLessThanOrEqual(DEMO_ANALYTICS_DAYS);
    }
    expect(daily.some((row) => (row.impressions ?? 0) > 0 && (row.engagements ?? 0) > 0)).toBe(true);
    expect(daily.filter((row) => row.platform === 'X').every((row) => row.postReach === null)).toBe(true);
  });

  it('changes nothing when the analytics seed runs again', async () => {
    const snapshot = async () => ({
      variants: await client().postVariant.count(),
      published: await client().postVariant.count({ where: { status: 'PUBLISHED' } }),
      snapshots: await client().metricSnapshot.count(),
      accountDays: await client().accountMetricSnapshot.count(),
      daily: await client().analyticsDaily.findMany({
        orderBy: [{ socialAccountId: 'asc' }, { day: 'asc' }],
        omit: { updatedAt: true },
      }),
    });
    const before = await snapshot();
    const demo = await seedDemoData(client(), 'test-seed-password');

    await expect(seedDemoAnalytics(client(), demo, NOW)).resolves.toMatchObject({
      created: false,
      published: before.published,
    });
    expect(await snapshot()).toEqual(before);
  });
});
