import { verifyPassword } from '@smp/crypto';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  loadRunReport,
  PrismaPublishScheduler,
  seedLoadFixture,
  type LoadFixture,
  type PrismaClient,
  type SystemPrismaClient,
} from '../src';

// Guide step 8.5 on PostgreSQL: the data of the load test pass every constraint, the owners sign
// in with the password of the run, the scheduler queues every due variant of the run in one
// claim, the history of each workspace is rolled up, a run id in use is refused, and the report
// of a run counts what the database holds of it.

const PASSWORD = 'Kurbelwelle-Zitronenfalter-81';

describe('the data of the load test on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let prisma: PrismaClient | undefined;
  let system: SystemPrismaClient | undefined;
  let fixture: LoadFixture | undefined;
  const now = new Date();
  // Within the 30 seconds the scheduler queues ahead.
  const dueAt = new Date(now.getTime() + 5_000);
  const options = {
    run: 'it1',
    organizations: 2,
    duePostsPerWorkspace: 3,
    dueAt,
    spreadSeconds: 0,
    latencyMs: 250,
    now,
  };

  const clients = () => {
    if (!prisma || !system || !fixture) {
      throw new Error('not started');
    }
    return { prisma, system, fixture };
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    prisma = createPrismaClient(database.url('app_system'));
    system = createSystemPrismaClient(database.url('app_system'));
    fixture = await seedLoadFixture(prisma, options, PASSWORD);
  }, 300_000);

  afterAll(async () => {
    await Promise.all([prisma?.$disconnect(), system?.$disconnect()]);
    await database?.stop();
  });

  it('describe the run for k6, without the password', () => {
    const { fixture } = clients();

    expect(fixture).toMatchObject({
      run: 'it1',
      dueAt: dueAt.toISOString(),
      spreadSeconds: 0,
      dueVariants: 24,
    });
    expect(
      fixture.workspaces.map((workspace) => [workspace.slug, workspace.email, workspace.dueVariants]),
    ).toEqual([
      ['load-it1-1', 'owner.1.it1@load.test', 12],
      ['load-it1-2', 'owner.2.it1@load.test', 12],
    ]);
    expect(JSON.stringify(fixture)).not.toContain(PASSWORD);
  });

  it('let the owners sign in with the password of the run', async () => {
    const { prisma, fixture } = clients();
    const credentials = await prisma.account.findMany({
      where: { providerId: 'credential', user: { email: { in: fixture.workspaces.map((w) => w.email) } } },
      select: { password: true },
    });

    expect(credentials).toHaveLength(2);
    for (const { password } of credentials) {
      await expect(verifyPassword(password ?? '', PASSWORD)).resolves.toBe(true);
    }
  });

  it('give the mock accounts the latency of the run and every due variant its image', async () => {
    const { prisma } = clients();
    const accounts = await prisma.socialAccount.findMany({
      where: { workspace: { slug: { startsWith: 'load-it1-' } } },
      select: { settings: true },
    });
    const due = await prisma.postVariant.findMany({
      where: { scheduledAt: dueAt, status: 'SCHEDULED' },
      select: { media: { select: { asset: { select: { status: true } } } } },
    });

    expect(accounts).toHaveLength(8);
    expect(accounts.every((account) => JSON.stringify(account.settings) === '{"latencyMs":250}')).toBe(true);
    expect(due).toHaveLength(24);
    expect(
      due.every((variant) => variant.media.length === 1 && variant.media[0]?.asset.status === 'READY'),
    ).toBe(true);
  });

  it('roll up the history of every workspace', async () => {
    const { prisma } = clients();
    const days = await prisma.analyticsDaily.groupBy({
      by: ['workspaceId'],
      where: { workspace: { slug: { startsWith: 'load-it1-' } } },
      _count: { _all: true },
    });

    expect(days).toHaveLength(2);
    expect(days.every((day) => day._count._all > 0)).toBe(true);
  });

  it('hand every due variant of the run to the scheduler in one claim', async () => {
    const { system } = clients();

    const claimed = await new PrismaPublishScheduler(system, { batchSize: 500 }).claimDue();

    expect(claimed.missed).toEqual([]);
    expect(claimed.queued).toHaveLength(24);
    expect(claimed.queued.every((variant) => variant.scheduledAt.getTime() === dueAt.getTime())).toBe(true);
  });

  it('report the run: statuses, lags, publications per second, attempts, outbox and metrics polls', async () => {
    const { prisma, system } = clients();
    // 20 of the 24 queued variants go out 2 s after their due time, and 10 of those that are not on
    // X get their first metrics poll 4 s after that, when a scale of 3600 made it due after 1 s.
    await prisma.$executeRaw`
      UPDATE post_variant v SET status = 'PUBLISHED', published_at = v.scheduled_at + interval '2 seconds'
        FROM (SELECT id FROM post_variant WHERE scheduled_at = ${dueAt} ORDER BY id LIMIT 20) chosen
       WHERE v.id = chosen.id`;
    await prisma.$executeRaw`
      INSERT INTO publish_attempt (id, workspace_id, variant_id, schedule_version, attempt_number, trigger,
                                   outcome, lease_owner, started_at)
      SELECT gen_random_uuid(), workspace_id, id, schedule_version, 1, 'schedule', 'PUBLISHED', 'load', scheduled_at
        FROM post_variant WHERE scheduled_at = ${dueAt} AND status = 'PUBLISHED'`;
    await prisma.$executeRaw`
      INSERT INTO metric_snapshot (id, workspace_id, variant_id, social_account_id, platform, step, raw,
                                   mapping_version, captured_at)
      SELECT gen_random_uuid(), workspace_id, id, social_account_id, platform, 0, '{}', 1,
             published_at + interval '4 seconds'
        FROM post_variant
       WHERE scheduled_at = ${dueAt} AND status = 'PUBLISHED' AND platform <> 'X'
       ORDER BY id LIMIT 10`;

    const report = await loadRunReport(system, { run: 'it1', dueAt, spreadSeconds: 0 }, 3600);

    expect(report.statuses).toEqual({ PUBLISHED: 20, QUEUED: 4 });
    expect(report.queuedAfterDue?.count).toBe(24);
    expect(report.publishedAfterDue).toEqual({ p50: 2, p95: 2, p99: 2, max: 2, count: 20 });
    expect(report.publishing).toMatchObject({ perSecond: 20, maxPerSecond: 20 });
    expect(report.attempts).toEqual({ PUBLISHED: 20 });
    // The claim wrote the events of the queued variants; no relay ran.
    expect(report.outbox?.count).toBeGreaterThanOrEqual(24);
    expect(report.outbox?.pending).toBe(report.outbox?.count);
    expect(report.metrics).toMatchObject({
      measured: 10,
      snapshots: 10,
      perSecond: 10,
      maxPerSecond: 10,
      afterDue: { p50: 3, max: 3, count: 10 },
    });
  });

  it('refuse a run id that is in use', async () => {
    const { prisma } = clients();

    await expect(seedLoadFixture(prisma, options, PASSWORD)).rejects.toThrow(/run it1/);
  });
});
