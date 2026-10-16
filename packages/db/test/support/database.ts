import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

// Starts PostgreSQL with the real init script of the local stack and applies all migrations as
// app_migrator, exactly as `docker compose up` and `pnpm db:migrate` do.
const PACKAGE_ROOT = resolve(__dirname, '../..');
const INIT_DIR = resolve(PACKAGE_ROOT, '../../infra/docker/postgres/init');

export const PASSWORDS = {
  migrator: 'test-migrator-password',
  user: 'test-user-password',
  system: 'test-system-password',
} as const;

export type DatabaseRole = 'app_migrator' | 'app_user' | 'app_system';

const PASSWORD_BY_ROLE: Record<DatabaseRole, string> = {
  app_migrator: PASSWORDS.migrator,
  app_user: PASSWORDS.user,
  app_system: PASSWORDS.system,
};

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  url: (role: DatabaseRole, database?: string) => string;
  connectAs: (role: DatabaseRole, database?: string) => Promise<Client>;
  stop: () => Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17.11-alpine')
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

  const url = (role: DatabaseRole, database = 'smp'): string =>
    `postgresql://${role}:${PASSWORD_BY_ROLE[role]}@${container.getHost()}:${String(container.getMappedPort(5432))}/${database}`;

  execFileSync(join(PACKAGE_ROOT, 'node_modules', '.bin', 'prisma'), ['migrate', 'deploy'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, MIGRATION_DATABASE_URL: url('app_migrator') },
    stdio: 'pipe',
  });

  return {
    container,
    url,
    connectAs: async (role, database) => {
      const client = new Client({ connectionString: url(role, database) });
      await client.connect();
      return client;
    },
    stop: async () => {
      await container.stop();
    },
  };
}
