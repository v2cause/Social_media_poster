import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { findRlsViolations } from '../src';
import { ids, inContext } from './support/sql-context';

// Guide step 4.1: the channel and publishing tables are isolated per workspace (the cost ledger
// per organization), logs and ledgers are append-only for app_user, and webhooks are global.

const f = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  a1: randomUUID(),
  b1: randomUUID(),
  connectionA: randomUUID(),
  connectionB: randomUUID(),
  accountA: randomUUID(),
  accountB: randomUUID(),
  postA: randomUUID(),
  postB: randomUUID(),
  variantA: randomUUID(),
  variantB: randomUUID(),
  attemptA: randomUUID(),
  attemptB: randomUUID(),
  outboxA: randomUUID(),
  outboxB: randomUUID(),
  costA: randomUUID(),
  costB: randomUUID(),
};

const WORKSPACE_TABLES = ['social_connection', 'social_account', 'publish_attempt', 'outbox_event'];

describe('row-level security of the channel and publishing tables', () => {
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
  const inA = <T>(fn: () => Promise<T>): Promise<T> =>
    inContext(app(), { organizationId: f.orgA, workspaceId: f.a1 }, fn);

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    try {
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [f.orgA, f.orgB],
      );
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'channels-a1', 'A1', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'channels-b1', 'B1', 'Europe/Berlin', 'en', now())`,
        [f.a1, f.orgA, f.b1, f.orgB],
      );
      for (const [org, ws, connection, account, post, variant, attempt, outbox, cost] of [
        [f.orgA, f.a1, f.connectionA, f.accountA, f.postA, f.variantA, f.attemptA, f.outboxA, f.costA],
        [f.orgB, f.b1, f.connectionB, f.accountB, f.postB, f.variantB, f.attemptB, f.outboxB, f.costB],
      ] as const) {
        await system.query(
          `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                          access_token_sealed, scopes, updated_at)
           VALUES ($1, $2, 'LINKEDIN', 'MOCK', 'member-1', 'Mira Mock', '\\x01'::bytea, '{w_member_social}', now())`,
          [connection, ws],
        );
        // The same platform user and target in both workspaces: unique only within a workspace.
        await system.query(
          `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
           VALUES ($1, $2, $3, 'LINKEDIN', 'PROFILE', 'urn:li:person:member-1', 'Mira Mock', now())`,
          [account, ws, connection],
        );
        await system.query(
          `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
          [post, ws],
        );
        await system.query(
          `INSERT INTO post_variant (id, workspace_id, post_id, social_account_id, platform, target_key, updated_at)
           VALUES ($1, $2, $3, $4, 'LINKEDIN', 't1', now())`,
          [variant, ws, post, account],
        );
        await system.query(
          `INSERT INTO publish_attempt (id, workspace_id, variant_id, schedule_version, attempt_number, trigger,
                                        lease_owner)
           VALUES ($1, $2, $3, 1, 1, 'schedule', 'worker-1')`,
          [attempt, ws, variant],
        );
        await system.query(
          `INSERT INTO outbox_event (id, workspace_id, type, payload)
           VALUES ($1, $2, 'variant.publish-requested', '{}'::jsonb)`,
          [outbox, ws],
        );
        await system.query(
          `INSERT INTO api_cost_record (id, organization_id, workspace_id, social_account_id, platform, operation,
                                        cost_micros, source_type, source_id)
           VALUES ($1, $2, $3, $4, 'X', 'x.post_create', 10000, 'publish_attempt', $5)`,
          [cost, org, ws, account, attempt],
        );
      }
    } finally {
      await system.end();
    }
    runtime = await database.connectAs('app_user');
  }, 300_000);

  afterAll(async () => {
    await runtime?.end();
    await database?.stop();
  });

  it('passes the RLS check with the channel and publishing tables', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      await expect(findRlsViolations(owner)).resolves.toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('shows the rows of the workspace in context and nothing without it', async () => {
    for (const table of WORKSPACE_TABLES) {
      const inWorkspace = await inA(() => ids(app(), `SELECT id FROM ${table}`));
      const orgOnly = await inContext(app(), { organizationId: f.orgA }, () =>
        ids(app(), `SELECT id FROM ${table}`),
      );
      expect(inWorkspace, table).toHaveLength(1);
      expect(orgOnly, table).toEqual([]);
    }
    expect(await inA(() => ids(app(), 'SELECT id FROM social_connection'))).toEqual([f.connectionA]);
    expect(await inA(() => ids(app(), 'SELECT id FROM publish_attempt'))).toEqual([f.attemptA]);
    // The cost ledger belongs to the organization, like the usage ledger.
    const costs = await inContext(app(), { organizationId: f.orgA }, () =>
      ids(app(), 'SELECT id FROM api_cost_record'),
    );
    expect(costs).toEqual([f.costA]);
  });

  it('rejects writes into another workspace or organization', async () => {
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name, updated_at)
           VALUES (gen_random_uuid(), $1, 'X', 'MOCK', 'intruder', 'Intruder', now())`,
          [f.b1],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const altered = await inA(() =>
      app().query(`UPDATE social_connection SET status = 'REVOKED' WHERE id = $1`, [f.connectionB]),
    );
    expect(altered.rowCount).toBe(0);
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO outbox_event (id, workspace_id, type, payload) VALUES (gen_random_uuid(), $1, 'x', '{}')`,
          [f.b1],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO api_cost_record (id, organization_id, platform, operation, cost_micros, source_type, source_id)
           VALUES (gen_random_uuid(), $1, 'X', 'x.post_create', 1, 'publish_attempt', gen_random_uuid())`,
          [f.orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('lets app_user write the outbox and the logs but never rewrite or remove them', async () => {
    await inA(() =>
      app().query(
        `INSERT INTO outbox_event (id, workspace_id, type, payload) VALUES (gen_random_uuid(), $1, 'variant.status', '{}')`,
        [f.a1],
      ),
    );
    await inA(() =>
      app().query(`UPDATE publish_attempt SET outcome = 'PUBLISHED', finished_at = now() WHERE id = $1`, [
        f.attemptA,
      ]),
    );
    for (const statement of [
      ['DELETE FROM publish_attempt WHERE id = $1', f.attemptA],
      ['UPDATE outbox_event SET processed_at = now() WHERE id = $1', f.outboxA],
      ['DELETE FROM outbox_event WHERE id = $1', f.outboxA],
      ['UPDATE api_cost_record SET cost_micros = 0 WHERE id = $1', f.costA],
      ['DELETE FROM api_cost_record WHERE id = $1', f.costA],
    ] as const) {
      await expect(
        inA(() => app().query(statement[0], [statement[1]])),
        statement[0],
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('records a webhook once, without a tenant, and keeps it unchanged for app_user', async () => {
    const insert = `INSERT INTO webhook_event (id, provider, external_id, type, payload)
                    VALUES (gen_random_uuid(), 'meta', 'evt-1', 'deauthorize', '{}')
                    ON CONFLICT (provider, external_id) DO NOTHING`;
    expect((await app().query(insert)).rowCount).toBe(1);
    expect((await app().query(insert)).rowCount).toBe(0);
    await expect(app().query(`UPDATE webhook_event SET processed_at = now()`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app().query(`DELETE FROM webhook_event`)).rejects.toThrow(/permission denied/);
  });

  it('keeps variants when an account goes and removes attempts with their variant', async () => {
    await inA(() => app().query('DELETE FROM social_account WHERE id = $1', [f.accountA]));
    const variant = await inA(() =>
      app().query<{ social_account_id: string | null }>(
        'SELECT social_account_id FROM post_variant WHERE id = $1',
        [f.variantA],
      ),
    );
    expect(variant.rows).toEqual([{ social_account_id: null }]);
    await inA(() => app().query('DELETE FROM post_variant WHERE id = $1', [f.variantA]));
    expect(await inA(() => ids(app(), 'SELECT id FROM publish_attempt'))).toEqual([]);
  });
});
