import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { createPrismaClient, type PrismaClient } from '../src';

describe('database roles and migrations', () => {
  let database: TestDatabase | undefined;

  const db = (): TestDatabase => {
    if (!database) {
      throw new Error('PostgreSQL test container is not running');
    }
    return database;
  };

  beforeAll(async () => {
    database = await startTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database?.stop();
  });

  it('applies all migrations', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      const { rows } = await owner.query<{ migration_name: string; finished_at: Date | null }>(
        'SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY migration_name',
      );
      expect(rows.map((row) => row.migration_name)).toEqual([
        '0000_init',
        '0001_identity_tenancy',
        '0002_rls_tenancy',
        '0003_invitation_preview',
      ]);
      expect(rows.every((row) => row.finished_at instanceof Date)).toBe(true);
    } finally {
      await owner.end();
    }
  });

  it('installs the trusted extensions', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      const { rows } = await owner.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm') ORDER BY extname",
      );
      expect(rows.map((row) => row.extname)).toEqual(['citext', 'pg_trgm']);
    } finally {
      await owner.end();
    }
  });

  it('connects as app_user without bypassing row-level security', async () => {
    const runtime = await db().connectAs('app_user');
    try {
      const { rows } = await runtime.query<{ current_user: string; rolbypassrls: boolean }>(
        'SELECT current_user, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
      );
      expect(rows).toEqual([{ current_user: 'app_user', rolbypassrls: false }]);
    } finally {
      await runtime.end();
    }
  });

  it('keeps the runtime roles out of the shadow database', async () => {
    await expect(db().connectAs('app_user', 'smp_shadow')).rejects.toThrow(/permission denied for database/);
    await expect(db().connectAs('app_system', 'smp_shadow')).rejects.toThrow(
      /permission denied for database/,
    );
  });

  it('limits query and idle transaction time for the runtime roles', async () => {
    const runtime = await db().connectAs('app_user');
    try {
      const { rows } = await runtime.query<{ statement_timeout: string; idle: string }>(
        "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('idle_in_transaction_session_timeout') AS idle",
      );
      expect(rows).toEqual([{ statement_timeout: '30s', idle: '1min' }]);
      await expect(runtime.query('SET statement_timeout = 50; SELECT pg_sleep(1)')).rejects.toThrow(
        /canceling statement due to statement timeout/,
      );
    } finally {
      await runtime.end();
    }
  });

  it('lets app_system bypass row-level security', async () => {
    const system = await db().connectAs('app_system');
    try {
      const { rows } = await system.query<{ rolbypassrls: boolean }>(
        'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows).toEqual([{ rolbypassrls: true }]);
    } finally {
      await system.end();
    }
  });

  it('grants the runtime roles access to tables that app_migrator creates later', async () => {
    const owner = await db().connectAs('app_migrator');
    try {
      await owner.query('CREATE TABLE grant_probe (id integer PRIMARY KEY)');
    } finally {
      await owner.end();
    }

    const runtime = await db().connectAs('app_user');
    try {
      await runtime.query('INSERT INTO grant_probe (id) VALUES (1)');
      const { rows } = await runtime.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM grant_probe',
      );
      expect(rows).toEqual([{ count: '1' }]);
      await runtime.query('DELETE FROM grant_probe');
    } finally {
      await runtime.end();
    }
  });

  it('opens a Prisma client as app_user through the driver adapter', async () => {
    const prisma: PrismaClient = createPrismaClient(db().url('app_user'));
    try {
      const rows = await prisma.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      expect(rows).toEqual([{ current_user: 'app_user' }]);
    } finally {
      await prisma.$disconnect();
    }
  });
});
