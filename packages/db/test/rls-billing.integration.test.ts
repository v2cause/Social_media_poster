import { randomUUID } from 'node:crypto';

import { PLAN_KEYS, planLimitsSchema } from '@smp/contracts';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { findRlsViolations } from '../src';
import { inContext } from './support/sql-context';

// Guide step 7.1: the price list is reference data nobody changes at runtime; a subscription is
// visible only to its organization, app_user adds nothing but the trial of a new organization and
// changes nothing but its Stripe customer. Plan and status come from app_system.

const f = { orgA: randomUUID(), orgB: randomUUID() };

const TRIAL_INSERT = `INSERT INTO subscription (id, organization_id, plan_key, status, trial_ends_at, read_only_at, updated_at)
  VALUES (gen_random_uuid(), $1, $2, $3, now() + interval '14 days', now() + interval '14 days', now())`;

describe('row-level security of billing', () => {
  let database: TestDatabase | undefined;
  let runtime: Client | undefined;

  const db = (): TestDatabase => {
    if (!database) {
      throw new Error('PostgreSQL test container is not running');
    }
    return database;
  };
  const app = (): Client => {
    if (!runtime) {
      throw new Error('app_user is not connected');
    }
    return runtime;
  };
  const inOrg = <T>(organizationId: string, fn: () => Promise<T>): Promise<T> =>
    inContext(app(), { organizationId }, fn);

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    try {
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [f.orgA, f.orgB],
      );
      await system.query(
        `INSERT INTO subscription (id, organization_id, plan_key, status, stripe_customer_id, stripe_subscription_id, updated_at)
         VALUES (gen_random_uuid(), $1, 'pro', 'ACTIVE', 'cus_B', 'sub_B', now())`,
        [f.orgB],
      );
    } finally {
      await system.end();
    }
    runtime = await database.connectAs('app_user');
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await database?.stop();
  });

  it('passes the RLS check with the new tables and policies', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      await expect(findRlsViolations(owner)).resolves.toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('ships the price list with valid limits, a lookup key for every paid plan and the trial first', async () => {
    const { rows } = await app().query<{ key: string; limits: unknown; price_lookup_key: string | null }>(
      'SELECT key, limits, price_lookup_key FROM plan ORDER BY position',
    );
    expect(rows.map((row) => row.key)).toEqual([...PLAN_KEYS]);
    for (const row of rows) {
      expect(planLimitsSchema.safeParse(row.limits).success, row.key).toBe(true);
      expect(row.price_lookup_key === null, row.key).toBe(row.key === 'trial');
    }
  });

  it('keeps the price list out of reach of app_user and app_system', async () => {
    const system = await db().connectAs('app_system');
    try {
      for (const client of [app(), system]) {
        for (const statement of [
          `UPDATE plan SET limits = '{}' WHERE key = 'trial'`,
          `INSERT INTO plan (key, limits, position) VALUES ('free', '{}', 9)`,
          `DELETE FROM plan WHERE key = 'trial'`,
        ]) {
          await expect(client.query(statement), statement).rejects.toThrow(/permission denied/);
        }
      }
    } finally {
      await system.end();
    }
  });

  it('shows a subscription only to its organization', async () => {
    const { rows } = await inOrg(f.orgB, () =>
      app().query<{ plan_key: string }>('SELECT plan_key FROM subscription'),
    );
    expect(rows).toEqual([{ plan_key: 'pro' }]);
    const foreign = await inOrg(f.orgA, () => app().query('SELECT id FROM subscription'));
    expect(foreign.rows).toEqual([]);
    const none = await app().query('SELECT id FROM subscription');
    expect(none.rows).toEqual([]);
  });

  it('lets a new organization add its trial and nothing else', async () => {
    for (const [plan, status] of [
      ['pro', 'TRIALING'],
      ['trial', 'ACTIVE'],
    ] as const) {
      await expect(
        inOrg(f.orgA, () => app().query(TRIAL_INSERT, [f.orgA, plan, status])),
        `${plan} ${status}`,
      ).rejects.toThrow(/row-level security/);
    }
    await expect(
      inOrg(f.orgA, () =>
        app().query(
          `INSERT INTO subscription (id, organization_id, plan_key, status, stripe_subscription_id, updated_at)
           VALUES (gen_random_uuid(), $1, 'trial', 'TRIALING', 'sub_forged', now())`,
          [f.orgA],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inOrg(f.orgA, () => app().query(TRIAL_INSERT, [f.orgB, 'trial', 'TRIALING'])),
    ).rejects.toThrow(/row-level security|duplicate key/);
    const added = await inOrg(f.orgA, () => app().query(TRIAL_INSERT, [f.orgA, 'trial', 'TRIALING']));
    expect(added.rowCount).toBe(1);
  });

  it('lets app_user store the Stripe customer of its organization, but never plan or status', async () => {
    const stored = await inOrg(f.orgA, () =>
      app().query(
        `UPDATE subscription SET stripe_customer_id = 'cus_A', updated_at = now() WHERE organization_id = $1`,
        [f.orgA],
      ),
    );
    expect(stored.rowCount).toBe(1);
    const foreign = await inOrg(f.orgA, () =>
      app().query(`UPDATE subscription SET stripe_customer_id = 'cus_X' WHERE organization_id = $1`, [
        f.orgB,
      ]),
    );
    expect(foreign.rowCount).toBe(0);
    for (const statement of [
      `UPDATE subscription SET plan_key = 'agency' WHERE organization_id = $1`,
      `UPDATE subscription SET status = 'ACTIVE' WHERE organization_id = $1`,
      `UPDATE subscription SET read_only_at = NULL WHERE organization_id = $1`,
      `DELETE FROM subscription WHERE organization_id = $1`,
    ]) {
      await expect(
        inOrg(f.orgA, () => app().query(statement, [f.orgA])),
        statement,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('leaves the report marks of the ledgers to app_system', async () => {
    for (const statement of [
      `UPDATE usage_record SET stripe_report_id = 'forged' WHERE organization_id = $1`,
      `UPDATE api_cost_record SET reported_to_stripe_at = now() WHERE organization_id = $1`,
    ]) {
      await expect(
        inOrg(f.orgA, () => app().query(statement, [f.orgA])),
        statement,
      ).rejects.toThrow(/permission denied/);
    }
  });
});
