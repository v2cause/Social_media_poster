import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { findRlsViolations } from '../src';

interface TenantContext {
  userId?: string;
  organizationId?: string;
  workspaceId?: string;
  invitationTokenHash?: string;
}

// Sets the context transaction-locally, as the tenant extension does, and runs fn inside.
async function inContext<T>(client: Client, context: TenantContext, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.organization_id', $2, true),
              set_config('app.workspace_id', $3, true),
              set_config('app.invitation_token_hash', $4, true)`,
      [
        context.userId ?? '',
        context.organizationId ?? '',
        context.workspaceId ?? '',
        context.invitationTokenHash ?? '',
      ],
    );
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function ids(client: Client, sql: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(sql);
  return rows.map((row) => row.id).sort();
}

// Two organizations: A with workspace a1 and owner alice; B with workspaces b1 and b2, the
// unrestricted admin dave and the editor bob, who is restricted to b2.
const fixture = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  a1: randomUUID(),
  b1: randomUUID(),
  b2: randomUUID(),
  alice: randomUUID(),
  bob: randomUUID(),
  dave: randomUUID(),
  bobMembership: randomUUID(),
  invitationToBob: randomUUID(),
  auditA: randomUUID(),
  auditB: randomUUID(),
  flagGlobal: randomUUID(),
  flagA: randomUUID(),
  flagB: randomUUID(),
  tokenHash: 'a'.repeat(64),
};

describe('row-level security of the tenancy tables', () => {
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

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    const f = fixture;
    try {
      await system.query(
        `INSERT INTO users (id, name, email, updated_at) VALUES
           ($1, 'Alice', 'alice@example.test', now()),
           ($2, 'Bob', 'bob@example.test', now()),
           ($3, 'Dave', 'dave@example.test', now())`,
        [f.alice, f.bob, f.dave],
      );
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [f.orgA, f.orgB],
      );
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'a1', 'A1', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'b1', 'B1', 'Europe/Berlin', 'de', now()),
                ($5, $4, 'b2', 'B2', 'Europe/Berlin', 'de', now())`,
        [f.a1, f.orgA, f.b1, f.orgB, f.b2],
      );
      await system.query(
        `INSERT INTO workspace_settings (workspace_id, updated_at)
         VALUES ($1, now()), ($2, now()), ($3, now())`,
        [f.a1, f.b1, f.b2],
      );
      await system.query(
        `INSERT INTO membership (id, organization_id, user_id, role, updated_at) VALUES
           (gen_random_uuid(), $1, $2, 'OWNER', now()),
           ($3, $4, $5, 'EDITOR', now()),
           (gen_random_uuid(), $4, $6, 'ADMIN', now())`,
        [f.orgA, f.alice, f.bobMembership, f.orgB, f.bob, f.dave],
      );
      await system.query(
        `INSERT INTO membership_workspace (membership_id, workspace_id, organization_id)
         VALUES ($1, $2, $3)`,
        [f.bobMembership, f.b2, f.orgB],
      );
      await system.query(
        `INSERT INTO invitation (id, organization_id, email, role, token_hash, invited_by_id, expires_at)
         VALUES ($1, $2, 'BOB@example.test', 'VIEWER', $3, $4, now() + interval '7 days')`,
        [f.invitationToBob, f.orgA, f.tokenHash, f.alice],
      );
      await system.query(
        `INSERT INTO audit_log (id, organization_id, action, target_type)
         VALUES ($1, $2, 'org.create', 'Organization'), ($3, $4, 'org.create', 'Organization')`,
        [f.auditA, f.orgA, f.auditB, f.orgB],
      );
      await system.query(
        `INSERT INTO notification (id, user_id, type)
         VALUES (gen_random_uuid(), $1, 'test'), (gen_random_uuid(), $2, 'test')`,
        [f.alice, f.bob],
      );
      await system.query(
        `INSERT INTO feature_flag (id, key, organization_id, enabled, updated_at)
         VALUES ($1, 'global', NULL, true, now()),
                ($2, 'only-a', $3, true, now()),
                ($4, 'only-b', $5, true, now())`,
        [f.flagGlobal, f.flagA, f.orgA, f.flagB, f.orgB],
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

  describe('check-rls', () => {
    it('finds no violations in the migrated schema', async () => {
      const owner = await db().connectAs('app_migrator');
      try {
        await expect(findRlsViolations(owner)).resolves.toEqual([]);
      } finally {
        await owner.end();
      }
    });

    it('reports tenant tables without forced RLS or policy and context reads without NULLIF', async () => {
      const owner = await db().connectAs('app_migrator');
      try {
        await owner.query('CREATE SCHEMA rls_probe');
        await owner.query('CREATE TABLE rls_probe.no_rls (id uuid, workspace_id uuid)');
        await owner.query('CREATE TABLE rls_probe.not_forced (id uuid, organization_id uuid)');
        await owner.query('ALTER TABLE rls_probe.not_forced ENABLE ROW LEVEL SECURITY');
        await owner.query(
          `CREATE POLICY guarded ON rls_probe.not_forced
             USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)`,
        );
        await owner.query('CREATE TABLE rls_probe.unguarded (id uuid, workspace_id uuid)');
        await owner.query('ALTER TABLE rls_probe.unguarded ENABLE ROW LEVEL SECURITY');
        await owner.query('ALTER TABLE rls_probe.unguarded FORCE ROW LEVEL SECURITY');
        await owner.query(
          `CREATE POLICY bare ON rls_probe.unguarded
             USING (workspace_id = current_setting('app.workspace_id', true)::uuid)`,
        );
        await owner.query('CREATE TABLE rls_probe.untenanted (id uuid)');

        await expect(findRlsViolations(owner, 'rls_probe')).resolves.toEqual([
          { table: 'no_rls', problem: 'rls_disabled' },
          { table: 'no_rls', problem: 'no_policy' },
          { table: 'not_forced', problem: 'rls_not_forced' },
          { table: 'unguarded', problem: 'context_without_nullif', policy: 'bare' },
        ]);
      } finally {
        await owner.query('DROP SCHEMA IF EXISTS rls_probe CASCADE');
        await owner.end();
      }
    });
  });

  it('returns no rows without context, also on a connection that had context before', async () => {
    const before = await ids(app(), 'SELECT id FROM workspace');
    const during = await inContext(app(), { organizationId: fixture.orgA }, () =>
      ids(app(), 'SELECT id FROM workspace'),
    );
    const after = await ids(app(), 'SELECT id FROM workspace');

    expect(before).toEqual([]);
    expect(during).toEqual([fixture.a1]);
    expect(after).toEqual([]);
  });

  it('limits the organization context to the data of that organization', async () => {
    const seen = await inContext(app(), { organizationId: fixture.orgA }, async () => ({
      organizations: await ids(app(), 'SELECT id FROM organization'),
      workspaces: await ids(app(), 'SELECT id FROM workspace'),
      memberships: await ids(app(), 'SELECT organization_id AS id FROM membership'),
      invitations: await ids(app(), 'SELECT id FROM invitation'),
      audit: await ids(app(), 'SELECT id FROM audit_log'),
    }));

    expect(seen).toEqual({
      organizations: [fixture.orgA],
      workspaces: [fixture.a1],
      memberships: [fixture.orgA],
      invitations: [fixture.invitationToBob],
      audit: [fixture.auditA],
    });
  });

  it('rejects writes into another organization', async () => {
    await expect(
      inContext(app(), { organizationId: fixture.orgA }, () =>
        app().query(
          `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
           VALUES (gen_random_uuid(), $1, 'intruder', 'X', 'UTC', 'en', now())`,
          [fixture.orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    const moved = await inContext(app(), { organizationId: fixture.orgA }, () =>
      app().query('UPDATE workspace SET organization_id = $1', [fixture.orgB]),
    ).catch((error: unknown) => error);
    expect(moved).toBeInstanceOf(Error);
    expect(String(moved)).toMatch(/row-level security/);
  });

  it('shows a user their own memberships, organizations and permitted workspaces', async () => {
    const bob = await inContext(app(), { userId: fixture.bob }, async () => ({
      memberships: await ids(app(), 'SELECT id FROM membership'),
      restrictions: await ids(app(), 'SELECT workspace_id AS id FROM membership_workspace'),
      organizations: await ids(app(), 'SELECT id FROM organization'),
      workspaces: await ids(app(), 'SELECT id FROM workspace'),
    }));
    const dave = await inContext(app(), { userId: fixture.dave }, () =>
      ids(app(), 'SELECT id FROM workspace'),
    );

    expect(bob).toEqual({
      memberships: [fixture.bobMembership],
      restrictions: [fixture.b2],
      organizations: [fixture.orgB],
      workspaces: [fixture.b2],
    });
    expect(dave).toEqual([fixture.b1, fixture.b2].sort());
  });

  it('shows invitations to the address of the user and to the holder of the link', async () => {
    const toBob = await inContext(app(), { userId: fixture.bob }, () =>
      ids(app(), 'SELECT id FROM invitation'),
    );
    const toDave = await inContext(app(), { userId: fixture.dave }, () =>
      ids(app(), 'SELECT id FROM invitation'),
    );
    const byToken = await inContext(app(), { invitationTokenHash: fixture.tokenHash }, () =>
      ids(app(), 'SELECT id FROM invitation'),
    );
    const byWrongToken = await inContext(app(), { invitationTokenHash: 'b'.repeat(64) }, () =>
      ids(app(), 'SELECT id FROM invitation'),
    );

    expect(toBob).toEqual([fixture.invitationToBob]);
    expect(toDave).toEqual([]);
    expect(byToken).toEqual([fixture.invitationToBob]);
    expect(byWrongToken).toEqual([]);
  });

  it('keeps the audit log append-only for app_user', async () => {
    const inserted = await inContext(app(), { organizationId: fixture.orgA }, () =>
      app().query(
        `INSERT INTO audit_log (id, organization_id, action, target_type)
         VALUES (gen_random_uuid(), $1, 'test.insert', 'Test') RETURNING id`,
        [fixture.orgA],
      ),
    );
    expect(inserted.rowCount).toBe(1);

    for (const statement of ['UPDATE audit_log SET action = $1', 'DELETE FROM audit_log WHERE action = $1']) {
      await expect(
        inContext(app(), { organizationId: fixture.orgA }, () => app().query(statement, ['test.insert'])),
      ).rejects.toThrow(/permission denied for table audit_log/);
    }
  });

  it('keeps notifications per user', async () => {
    const alice = await inContext(app(), { userId: fixture.alice }, async () => {
      const { rows } = await app().query<{ user_id: string }>('SELECT user_id FROM notification');
      return rows.map((row) => row.user_id);
    });
    expect(alice).toEqual([fixture.alice]);

    await expect(
      inContext(app(), { userId: fixture.alice }, () =>
        app().query(`INSERT INTO notification (id, user_id, type) VALUES (gen_random_uuid(), $1, 'test')`, [
          fixture.bob,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('reads global flags and the flags of the current organization only', async () => {
    const flags = await inContext(app(), { organizationId: fixture.orgA }, () =>
      ids(app(), 'SELECT id FROM feature_flag'),
    );
    expect(flags).toEqual([fixture.flagGlobal, fixture.flagA].sort());

    await expect(
      inContext(app(), { organizationId: fixture.orgA }, () =>
        app().query(`UPDATE feature_flag SET enabled = false RETURNING id`),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('reads workspace settings only in the context of that workspace', async () => {
    const orgOnly = await inContext(app(), { organizationId: fixture.orgB }, () =>
      ids(app(), 'SELECT workspace_id AS id FROM workspace_settings'),
    );
    const inWorkspace = await inContext(
      app(),
      { organizationId: fixture.orgB, workspaceId: fixture.b2 },
      () => ids(app(), 'SELECT workspace_id AS id FROM workspace_settings'),
    );

    expect(orgOnly).toEqual([]);
    expect(inWorkspace).toEqual([fixture.b2]);
  });
});
