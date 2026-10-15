import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPrismaClient, type PrismaClient } from '../src';

// The real init script of the local stack runs in the container, so the test checks the
// same roles and grants that `docker compose up` creates.
const PACKAGE_ROOT = resolve(__dirname, '..');
const INIT_DIR = resolve(PACKAGE_ROOT, '../../infra/docker/postgres/init');

const PASSWORDS = {
  migrator: 'test-migrator-password',
  user: 'test-user-password',
  system: 'test-system-password',
};

describe('database roles and migrations', () => {
  let container: StartedPostgreSqlContainer | undefined;

  const startedContainer = (): StartedPostgreSqlContainer => {
    if (!container) {
      throw new Error('PostgreSQL test container is not running');
    }
    return container;
  };

  const url = (role: 'app_migrator' | 'app_user' | 'app_system', password: string): string => {
    const started = startedContainer();
    return `postgresql://${role}:${password}@${started.getHost()}:${String(started.getMappedPort(5432))}/smp`;
  };

  const connectAs = async (connectionString: string): Promise<Client> => {
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17.11-alpine')
      .withUsername('postgres')
      .withPassword('test-superuser-password')
      .withDatabase('postgres')
      .withEnvironment({
        APP_MIGRATOR_PASSWORD: PASSWORDS.migrator,
        APP_USER_PASSWORD: PASSWORDS.user,
        APP_SYSTEM_PASSWORD: PASSWORDS.system,
        POSTGRES_INITDB_ARGS: '--auth-local=scram-sha-256 --auth-host=scram-sha-256',
      })
      .withBindMounts([{ source: INIT_DIR, target: '/docker-entrypoint-initdb.d', mode: 'ro' }])
      .start();

    // Migrations run as the owner, exactly as `pnpm db:migrate` runs them.
    execFileSync(join(PACKAGE_ROOT, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, MIGRATION_DATABASE_URL: url('app_migrator', PASSWORDS.migrator) },
      stdio: 'pipe',
    });
  }, 300_000);

  afterAll(async () => {
    await container?.stop();
  });

  it('applies the init migration', async () => {
    const owner = await connectAs(url('app_migrator', PASSWORDS.migrator));
    try {
      const { rows } = await owner.query<{ migration_name: string; finished_at: Date | null }>(
        'SELECT migration_name, finished_at FROM _prisma_migrations',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.migration_name).toBe('0000_init');
      expect(rows[0]?.finished_at).toBeInstanceOf(Date);
    } finally {
      await owner.end();
    }
  });

  it('installs the trusted extensions', async () => {
    const owner = await connectAs(url('app_migrator', PASSWORDS.migrator));
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
    const runtime = await connectAs(url('app_user', PASSWORDS.user));
    try {
      const { rows } = await runtime.query<{ current_user: string; rolbypassrls: boolean }>(
        'SELECT current_user, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user',
      );
      expect(rows).toEqual([{ current_user: 'app_user', rolbypassrls: false }]);
    } finally {
      await runtime.end();
    }
  });

  it('lets app_system bypass row-level security', async () => {
    const system = await connectAs(url('app_system', PASSWORDS.system));
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
    const owner = await connectAs(url('app_migrator', PASSWORDS.migrator));
    try {
      await owner.query('CREATE TABLE grant_probe (id integer PRIMARY KEY)');
    } finally {
      await owner.end();
    }

    const runtime = await connectAs(url('app_user', PASSWORDS.user));
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
    const prisma: PrismaClient = createPrismaClient(url('app_user', PASSWORDS.user));
    try {
      const rows = await prisma.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      expect(rows).toEqual([{ current_user: 'app_user' }]);
    } finally {
      await prisma.$disconnect();
    }
  });
});
