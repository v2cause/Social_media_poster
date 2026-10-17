import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSystemPrismaClient, PrismaUsageReportStore, type SystemPrismaClient } from '../src';

// Guide step 7.3 on PostgreSQL: the daily report claims the AI usage and the X API costs of an
// organization since the start of its billing into one batch per meter and month, finds the
// batches it did not confirm again, and marks the records once Stripe took them.

const UNTIL = new Date('2026-10-17T00:00:00Z');

describe('the usage report store on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let system: SystemPrismaClient | undefined;
  const billed = randomUUID();
  const trial = randomUUID();

  const store = () => {
    if (!system) {
      throw new Error('not started');
    }
    return new PrismaUsageReportStore(system);
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    const fixtures = await database.connectAs('app_system');
    try {
      await fixtures.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Billed', now()), ($2, 'Trial', now())`,
        [billed, trial],
      );
      await fixtures.query(
        `INSERT INTO subscription (id, organization_id, plan_key, status, stripe_customer_id, stripe_subscription_id,
                                   billing_started_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'starter', 'ACTIVE', 'cus_billed', 'sub_billed', '2026-10-10T00:00:00Z', now())`,
        [billed],
      );
      await fixtures.query(
        `INSERT INTO subscription (id, organization_id, plan_key, status, trial_ends_at, read_only_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'trial', 'TRIALING', now(), now(), now())`,
        [trial],
      );
      const usage = [
        // In the trial before the plan was bought.
        [billed, 4_000_000, '2026-10-05T09:00:00Z'],
        [billed, 5_000_000, '2026-10-12T08:00:00Z'],
        [billed, 3_000_000, '2026-10-16T21:00:00Z'],
        // After the cutoff: the report of the next day.
        [billed, 1_000_000, '2026-10-17T00:01:00Z'],
        [trial, 2_000_000, '2026-10-16T10:00:00Z'],
      ] as const;
      for (const [organizationId, quantity, createdAt] of usage) {
        await fixtures.query(
          `INSERT INTO usage_record (id, organization_id, meter, source_type, source_id, quantity, period_start, created_at)
           VALUES (gen_random_uuid(), $1, 'ai_micros', 'ai_generation', gen_random_uuid(), $2, '2026-10-01', $3)`,
          [organizationId, quantity, createdAt],
        );
      }
      const costs = [
        ['X', 15_000, '2026-10-16T22:00:00Z'],
        ['X', 5_000, '2026-09-30T23:00:00Z'],
        ['LINKEDIN', 999, '2026-10-16T10:00:00Z'],
      ] as const;
      for (const [platform, costMicros, createdAt] of costs) {
        await fixtures.query(
          `INSERT INTO api_cost_record (id, organization_id, platform, operation, cost_micros, source_type, source_id, created_at)
           VALUES (gen_random_uuid(), $1, $2, 'x.post_create', $3, 'publish_attempt', gen_random_uuid(), $4)`,
          [billed, platform, costMicros, createdAt],
        );
      }
    } finally {
      await fixtures.end();
    }
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await system?.$disconnect();
    await database?.stop();
  });

  it('names the organizations whose billed usage was not reported yet', async () => {
    await expect(store().organizationsToReport(UNTIL)).resolves.toEqual([billed]);
    await expect(store().organizationsToReport(new Date('2026-10-10T00:00:00Z'))).resolves.toEqual([]);
    await expect(store().subscriptionOf(billed)).resolves.toMatchObject({
      plan: { key: 'starter', limits: { aiCreditsMicros: 10_000_000 } },
      stripeCustomerId: 'cus_billed',
    });
  });

  it('claims one batch per meter and month and finds it again until it is confirmed', async () => {
    const window = { from: new Date('2026-10-10T00:00:00Z'), until: UNTIL };

    const batches = await store().claim(billed, window);

    expect(batches).toEqual([
      {
        identifier: `ai.${billed}.2026-10.2026-10-17`,
        meter: 'ai_overage',
        periodStart: new Date('2026-10-01T00:00:00Z'),
        quantity: 8_000_000n,
        latestAt: new Date('2026-10-16T21:00:00Z'),
      },
      {
        identifier: `x.${billed}.2026-10.2026-10-17`,
        meter: 'x_api_cost',
        periodStart: new Date('2026-10-01T00:00:00Z'),
        quantity: 15_000n,
        latestAt: new Date('2026-10-16T22:00:00Z'),
      },
    ]);
    const [ai] = batches;
    if (!ai) {
      throw new Error('no AI batch');
    }
    // The 4 USD of the trial count against the credits of October.
    await expect(store().creditedBefore(billed, ai, window.from)).resolves.toBe(4_000_000n);

    // A report of the next day finds the batches of this one, and claims the newer usage apart.
    const next = await store().claim(billed, { ...window, until: new Date('2026-10-18T00:00:00Z') });
    expect(next.map((batch) => [batch.identifier, batch.quantity])).toEqual([
      [`ai.${billed}.2026-10.2026-10-17`, 8_000_000n],
      [`x.${billed}.2026-10.2026-10-17`, 15_000n],
      [`ai.${billed}.2026-10.2026-10-18`, 1_000_000n],
    ]);

    for (const batch of next) {
      await store().confirm(billed, batch, new Date('2026-10-18T00:07:00Z'));
    }
    await expect(
      store().claim(billed, { ...window, until: new Date('2026-10-18T00:00:00Z') }),
    ).resolves.toEqual([]);
    await expect(store().organizationsToReport(new Date('2026-10-18T00:00:00Z'))).resolves.toEqual([]);
    // What was reported counts against the credits of the month from now on.
    await expect(
      store().creditedBefore(
        billed,
        { ...ai, identifier: `ai.${billed}.2026-10.2026-10-19` },
        new Date('2026-10-10T00:00:00Z'),
      ),
    ).resolves.toBe(13_000_000n);
  });
});
