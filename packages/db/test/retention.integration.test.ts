import { randomUUID } from 'node:crypto';

import { startTestDatabase, type TestDatabase } from '@smp/testing';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  createSystemPrismaClient,
  PrismaRetentionStore,
  type SystemPrismaClient,
} from '../src';
import { seedDemoData } from '../src/seed/demo';
import { seedDemoAnalytics } from '../src/seed/demo-analytics';
import { createOrganization, fillOrganization, type TestOrganization } from './support/organization-fixtures';

// Guide step 8.3 on PostgreSQL: the store clears the raw data of AI generations and keeps their
// counts and costs, deletes processed webhook events and leaves waiting ones, clears the
// connection data of the audit log and deletes expired sessions and old counters of the rate
// limits, and deletes the metrics of one organization before a moment, in batches of a limit,
// without touching another organization.

const NOW = new Date('2026-10-17T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe('the retention store on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let system: SystemPrismaClient | undefined;
  let fixtures: Client | undefined;
  let demo: { organizationId: string; workspaceId: string } | undefined;
  const other: TestOrganization = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };

  const clients = () => {
    if (!system || !fixtures || !demo) {
      throw new Error('not started');
    }
    return { store: new PrismaRetentionStore(system), sql: fixtures, demo };
  };
  const count = async (query: string, values: unknown[] = []): Promise<number> =>
    (await clients().sql.query<{ count: number }>(query, values)).rows[0]?.count ?? -1;

  beforeAll(async () => {
    database = await startTestDatabase();
    const seeder = createPrismaClient(database.url('app_system'));
    try {
      const seeded = await seedDemoData(seeder, 'test-seed-password');
      await seedDemoAnalytics(seeder, seeded, NOW);
      demo = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId };
    } finally {
      await seeder.$disconnect();
    }
    fixtures = await database.connectAs('app_system');
    await createOrganization(fixtures, other, { name: 'Other', slug: 'other', email: 'other@other.test' });
    await fillOrganization(fixtures, other.organizationId, other.workspaceId, other.ownerId);
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await Promise.all([system?.$disconnect(), fixtures?.end()]);
    await database?.stop();
  });

  it('clears the input and output of old AI generations and keeps their counts and costs', async () => {
    const { store, sql } = clients();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, createdAt] of [
      [ids[0], daysAgo(200)],
      [ids[1], daysAgo(190)],
      [ids[2], daysAgo(10)],
    ] as const) {
      await sql.query(
        `INSERT INTO ai_generation (id, workspace_id, task, prompt_version, provider, model_requested, effort,
                                    input, output, outcome, input_tokens, cost_micros, created_at)
         VALUES ($1, $2, 'GENERATE', 'v1', 'mock', 'mock-model', 'low', '{"brief": "Launch"}',
                 '{"text": "Hello"}', 'OK', 120, 4200, $3)`,
        [id, other.workspaceId, createdAt],
      );
    }

    // The fixtures hold one more generation, from today.
    await expect(store.clearAiRawData(daysAgo(180), 1)).resolves.toBe(1);
    await expect(store.clearAiRawData(daysAgo(180), 10)).resolves.toBe(1);
    await expect(store.clearAiRawData(daysAgo(180), 10)).resolves.toBe(0);

    const rows = await sql.query<{
      id: string;
      input: unknown;
      output: unknown;
      tokens: number;
      cost: string;
    }>(
      `SELECT id, input, output, input_tokens AS tokens, cost_micros::text AS cost
         FROM ai_generation WHERE id = ANY($1) ORDER BY created_at`,
      [ids],
    );
    expect(rows.rows).toEqual([
      { id: ids[0], input: null, output: null, tokens: 120, cost: '4200' },
      { id: ids[1], input: null, output: null, tokens: 120, cost: '4200' },
      { id: ids[2], input: { brief: 'Launch' }, output: { text: 'Hello' }, tokens: 120, cost: '4200' },
    ]);
  });

  it('deletes processed webhook events before a moment and leaves waiting ones', async () => {
    const { store, sql } = clients();
    for (const [externalId, processedAt] of [
      ['evt_old', daysAgo(31)],
      ['evt_recent', daysAgo(29)],
      ['evt_waiting', null],
    ] as const) {
      await sql.query(
        `INSERT INTO webhook_event (id, provider, external_id, type, payload, processed_at, received_at)
         VALUES ($1, 'stripe', $2, 'invoice.paid', '{}', $3, $4)`,
        [randomUUID(), externalId, processedAt, daysAgo(40)],
      );
    }

    await expect(store.deleteProcessedWebhooks(daysAgo(30), 10)).resolves.toBe(1);
    const left = await sql.query<{ external_id: string }>(
      `SELECT external_id FROM webhook_event ORDER BY external_id`,
    );
    expect(left.rows.map((row) => row.external_id)).toEqual(['evt_recent', 'evt_waiting']);
  });

  it('clears connection data: of the audit log, expired sessions and counters of the rate limits', async () => {
    const { store, sql } = clients();
    const entries = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, createdAt] of [
      [entries[0], daysAgo(45)],
      [entries[1], daysAgo(31)],
      [entries[2], daysAgo(29)],
    ] as const) {
      await sql.query(
        `INSERT INTO audit_log (id, organization_id, workspace_id, actor_user_id, action, target_type,
                                ip_address, user_agent, created_at)
         VALUES ($1, $2, $3, $4, 'post.create', 'post', '203.0.113.7', 'Browser/1.0', $5)`,
        [id, other.organizationId, other.workspaceId, other.ownerId, createdAt],
      );
    }
    const sessions = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, expiresAt] of [
      [sessions[0], daysAgo(31)],
      [sessions[1], daysAgo(29)],
      [sessions[2], daysAgo(-7)],
    ] as const) {
      await sql.query(
        `INSERT INTO session (id, user_id, token, expires_at, ip_address, user_agent, updated_at)
         VALUES ($1, $2, $3, $4, '203.0.113.7', 'Browser/1.0', now())`,
        [id, other.ownerId, randomUUID(), expiresAt],
      );
    }
    for (const [key, lastRequest] of [
      ['203.0.113.7|/sign-in/email', daysAgo(31)],
      ['203.0.113.7|/get-session', daysAgo(29)],
    ] as const) {
      await sql.query(`INSERT INTO rate_limit (id, key, count, last_request) VALUES ($1, $2, 1, $3)`, [
        randomUUID(),
        key,
        lastRequest.getTime(),
      ]);
    }

    // At most one row per table and call: an entry, a session and a counter.
    await expect(store.clearConnectionData(daysAgo(30), 1)).resolves.toBe(3);
    await expect(store.clearConnectionData(daysAgo(30), 10)).resolves.toBe(1);
    await expect(store.clearConnectionData(daysAgo(30), 10)).resolves.toBe(0);

    const audit = await sql.query<{ id: string; ip: string | null; agent: string | null; action: string }>(
      `SELECT id, ip_address AS ip, user_agent AS agent, action FROM audit_log WHERE id = ANY($1)
        ORDER BY created_at`,
      [entries],
    );
    expect(audit.rows).toEqual([
      { id: entries[0], ip: null, agent: null, action: 'post.create' },
      { id: entries[1], ip: null, agent: null, action: 'post.create' },
      { id: entries[2], ip: '203.0.113.7', agent: 'Browser/1.0', action: 'post.create' },
    ]);
    const left = await sql.query<{ id: string }>(
      `SELECT id FROM session WHERE id = ANY($1) ORDER BY expires_at`,
      [sessions],
    );
    expect(left.rows.map((row) => row.id)).toEqual([sessions[1], sessions[2]]);
    const counters = await sql.query<{ key: string }>(`SELECT key FROM rate_limit ORDER BY key`);
    expect(counters.rows.map((row) => row.key)).toEqual(['203.0.113.7|/get-session']);
  });

  it('lists the organizations with workspaces page by page', async () => {
    const { store, demo: org } = clients();
    const all = [org.organizationId, other.organizationId].sort();

    await expect(store.organizations(null, 10)).resolves.toEqual(all);
    await expect(store.organizations(null, 1)).resolves.toEqual([all[0]]);
    await expect(store.organizations(all[0] ?? null, 10)).resolves.toEqual([all[1]]);
  });

  it('deletes the metrics of one organization before a moment, in batches', async () => {
    const { store, sql, demo: org } = clients();
    const [account] = (
      await sql.query<{ id: string }>(`SELECT id FROM social_account WHERE workspace_id = $1`, [
        other.workspaceId,
      ])
    ).rows;
    await sql.query(
      `INSERT INTO analytics_daily (workspace_id, social_account_id, platform, day, updated_at)
       VALUES ($1, $2, 'X', $3::date, now())`,
      [other.workspaceId, account?.id, daysAgo(80)],
    );
    const metricsOf = async (workspaceId: string, before: Date) => ({
      snapshots: await count(
        `SELECT count(*)::int AS count FROM metric_snapshot WHERE workspace_id = $1 AND captured_at < $2`,
        [workspaceId, before],
      ),
      accounts: await count(
        `SELECT count(*)::int AS count FROM account_metric_snapshot WHERE workspace_id = $1 AND day < $2::date`,
        [workspaceId, before],
      ),
      daily: await count(
        `SELECT count(*)::int AS count FROM analytics_daily WHERE workspace_id = $1 AND day < $2::date`,
        [workspaceId, before],
      ),
    });
    const cutoff = daysAgo(40);
    const before = await metricsOf(org.workspaceId, cutoff);
    const kept = await metricsOf(org.workspaceId, NOW);
    expect(before.snapshots).toBeGreaterThan(5);
    expect(before.accounts).toBeGreaterThan(5);
    expect(before.daily).toBeGreaterThan(5);

    // At most five rows per table and call.
    await expect(store.deleteMetrics(org.organizationId, cutoff, 5)).resolves.toBe(15);
    let deleted = 15;
    for (let changed = 15; changed > 0;) {
      changed = await store.deleteMetrics(org.organizationId, cutoff, 1_000);
      deleted += changed;
    }

    expect(deleted).toBe(before.snapshots + before.accounts + before.daily);
    await expect(metricsOf(org.workspaceId, cutoff)).resolves.toEqual({
      snapshots: 0,
      accounts: 0,
      daily: 0,
    });
    await expect(metricsOf(org.workspaceId, NOW)).resolves.toEqual({
      snapshots: kept.snapshots - before.snapshots,
      accounts: kept.accounts - before.accounts,
      daily: kept.daily - before.daily,
    });
    // Another organization keeps its old numbers.
    await expect(metricsOf(other.workspaceId, cutoff)).resolves.toEqual({
      snapshots: 0,
      accounts: 0,
      daily: 1,
    });
  });
});
