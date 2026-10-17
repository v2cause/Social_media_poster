import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { findRlsViolations } from '../src';
import { inContext } from './support/sql-context';

// Guide step 6.1: the risk acknowledgements are isolated per workspace and stay as they were
// accepted, apart from revoked_at; a workspace switches its own flags, while global and
// organization flags stay with app_system.

const f = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  a1: randomUUID(),
  b1: randomUUID(),
  ackA: randomUUID(),
  ackB: randomUUID(),
  user: randomUUID(),
};

const FLAG = 'x_browser_automation';

describe('row-level security of the X browser', () => {
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
         VALUES ($1, $2, 'xb-a1', 'A1', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'xb-b1', 'B1', 'Europe/Berlin', 'de', now())`,
        [f.a1, f.orgA, f.b1, f.orgB],
      );
      for (const [id, ws] of [
        [f.ackA, f.a1],
        [f.ackB, f.b1],
      ] as const) {
        await system.query(
          `INSERT INTO risk_acknowledgement (id, workspace_id, user_id, subject, text_version, text_hash, locale,
                                             ip_address, accepted_at)
           VALUES ($1, $2, $3, 'x_browser', '2026-10-17', 'hash', 'de', '203.0.113.7', now())`,
          [id, ws, f.user],
        );
      }
      await system.query(
        `INSERT INTO feature_flag (id, key, organization_id, workspace_id, enabled, updated_at)
         VALUES (gen_random_uuid(), $1, NULL, NULL, true, now()),
                (gen_random_uuid(), $1, $2, NULL, true, now()),
                (gen_random_uuid(), $1, $3, $4, true, now())`,
        [FLAG, f.orgA, f.orgB, f.b1],
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

  it('passes the RLS check with the new table and policies', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      await expect(findRlsViolations(owner)).resolves.toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('shows the acknowledgements of the workspace in context and nothing without it', async () => {
    const { rows } = await inA(() => app().query<{ id: string }>('SELECT id FROM risk_acknowledgement'));
    expect(rows.map((row) => row.id)).toEqual([f.ackA]);
    const orgOnly = await inContext(app(), { organizationId: f.orgA }, () =>
      app().query('SELECT id FROM risk_acknowledgement'),
    );
    expect(orgOnly.rows).toEqual([]);
  });

  it('lets app_user add acknowledgements and revoke them, but never change or delete them', async () => {
    await inA(() =>
      app().query(
        `INSERT INTO risk_acknowledgement (id, workspace_id, user_id, subject, text_version, text_hash, locale,
                                           accepted_at)
         VALUES (gen_random_uuid(), $1, $2, 'x_browser', '2026-10-18', 'hash-2', 'en', now())`,
        [f.a1, f.user],
      ),
    );
    await expect(
      inA(() =>
        app().query(
          `INSERT INTO risk_acknowledgement (id, workspace_id, user_id, subject, text_version, text_hash, locale,
                                             accepted_at)
           VALUES (gen_random_uuid(), $1, $2, 'x_browser', '2026-10-18', 'hash-2', 'en', now())`,
          [f.b1, f.user],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const revoked = await inA(() =>
      app().query('UPDATE risk_acknowledgement SET revoked_at = now() WHERE id = $1', [f.ackA]),
    );
    expect(revoked.rowCount).toBe(1);
    for (const statement of [
      "UPDATE risk_acknowledgement SET text_version = 'forged' WHERE id = $1",
      'DELETE FROM risk_acknowledgement WHERE id = $1',
    ]) {
      await expect(
        inA(() => app().query(statement, [f.ackA])),
        statement,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('reads the global, organization and own flags and writes only the flags of its workspace', async () => {
    const visible = await inA(() =>
      app().query<{ organization_id: string | null; workspace_id: string | null }>(
        'SELECT organization_id, workspace_id FROM feature_flag WHERE key = $1 ORDER BY organization_id NULLS FIRST',
        [FLAG],
      ),
    );
    expect(visible.rows).toEqual([
      { organization_id: null, workspace_id: null },
      { organization_id: f.orgA, workspace_id: null },
    ]);

    await inA(() =>
      app().query(
        `INSERT INTO feature_flag (id, key, organization_id, workspace_id, enabled, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, true, now())`,
        [FLAG, f.orgA, f.a1],
      ),
    );
    const own = await inA(() =>
      app().query('UPDATE feature_flag SET enabled = false WHERE key = $1 AND workspace_id = $2', [
        FLAG,
        f.a1,
      ]),
    );
    expect(own.rowCount).toBe(1);

    // The kill switch, the gate of the organization and another workspace stay out of reach.
    for (const [organizationId, workspaceId] of [
      [null, null],
      [f.orgA, null],
      [f.orgB, f.b1],
    ] as const) {
      await expect(
        inA(() =>
          app().query(
            `INSERT INTO feature_flag (id, key, organization_id, workspace_id, enabled, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, false, now())`,
            [FLAG, organizationId, workspaceId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    }
    const global = await inA(() =>
      app().query('UPDATE feature_flag SET enabled = false WHERE key = $1 AND workspace_id IS NULL', [FLAG]),
    );
    expect(global.rowCount).toBe(0);
    await expect(
      inA(() => app().query('DELETE FROM feature_flag WHERE workspace_id = $1', [f.a1])),
    ).rejects.toThrow(/permission denied/);
  });
});
