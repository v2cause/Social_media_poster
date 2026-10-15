// Spike for guide step 0.14(b): row-level security with Prisma.
//
// Measures the cost of one tenant-scoped query per call, with set_config in the same batch
// transaction, against the same query without RLS. Also checks that the policy isolates
// organizations. The schema is created as app_migrator and dropped at the end.
//
// Run from the repository root with the local stack up: pnpm exec tsx tools/spikes/rls-overhead.ts

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createPrismaClient } from '@smp/db';
import { Client } from 'pg';

const QUERIES = 1_000;
const ROWS_PER_ORG = 500;
const SCHEMA = 'spike_rls';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Load the root .env first.`);
  }
  return value;
};

async function createFixtures(
  migratorUrl: string,
  orgA: string,
  orgB: string,
): Promise<{ plainIds: string[]; securedIds: string[] }> {
  const owner = new Client({ connectionString: migratorUrl });
  await owner.connect();
  try {
    await owner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await owner.query(`CREATE SCHEMA ${SCHEMA}`);
    await owner.query(
      `CREATE TABLE ${SCHEMA}.plain (id uuid PRIMARY KEY, organization_id uuid NOT NULL, value integer NOT NULL)`,
    );
    await owner.query(
      `CREATE TABLE ${SCHEMA}.secured (id uuid PRIMARY KEY, organization_id uuid NOT NULL, value integer NOT NULL)`,
    );
    await owner.query(`ALTER TABLE ${SCHEMA}.secured ENABLE ROW LEVEL SECURITY`);
    await owner.query(`ALTER TABLE ${SCHEMA}.secured FORCE ROW LEVEL SECURITY`);
    await owner.query(
      `CREATE POLICY org_isolation ON ${SCHEMA}.secured
         USING (organization_id = current_setting('app.organization_id', true)::uuid)
         WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid)`,
    );
    await owner.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO app_user`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO app_user`);

    const plainIds: string[] = [];
    const securedIds: string[] = [];
    // Plain rows exist for both orgs. Secured rows are inserted per organization with its own context.
    for (const org of [orgA, orgB]) {
      for (let i = 0; i < ROWS_PER_ORG; i++) {
        const id = randomUUID();
        plainIds.push(id);
        await owner.query(`INSERT INTO ${SCHEMA}.plain (id, organization_id, value) VALUES ($1, $2, $3)`, [
          id,
          org,
          i,
        ]);
      }
    }
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.organization_id', $1, true)`, [orgA]);
    for (let i = 0; i < ROWS_PER_ORG; i++) {
      const id = randomUUID();
      securedIds.push(id);
      await owner.query(`INSERT INTO ${SCHEMA}.secured (id, organization_id, value) VALUES ($1, $2, $3)`, [
        id,
        orgA,
        i,
      ]);
    }
    await owner.query('COMMIT');
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.organization_id', $1, true)`, [orgB]);
    for (let i = 0; i < ROWS_PER_ORG; i++) {
      const id = randomUUID();
      securedIds.push(id);
      await owner.query(`INSERT INTO ${SCHEMA}.secured (id, organization_id, value) VALUES ($1, $2, $3)`, [
        id,
        orgB,
        i,
      ]);
    }
    await owner.query('COMMIT');
    return { plainIds, securedIds };
  } finally {
    await owner.end();
  }
}

async function main(): Promise<void> {
  const migratorUrl = env('MIGRATION_DATABASE_URL');
  const runtimeUrl = env('DATABASE_URL');
  const orgA = randomUUID();
  const orgB = randomUUID();

  const { plainIds, securedIds } = await createFixtures(migratorUrl, orgA, orgB);
  const prisma = createPrismaClient(runtimeUrl);

  try {
    // Baseline: the same lookup without RLS, one query per call.
    const plainStart = performance.now();
    for (let i = 0; i < QUERIES; i++) {
      const id = plainIds[i % plainIds.length];
      await prisma.$queryRaw`SELECT value FROM spike_rls.plain WHERE id = ${id}::uuid`;
    }
    const plainMs = performance.now() - plainStart;

    // RLS: set the tenant in the same transaction, as the tenant extension will do.
    const securedStart = performance.now();
    for (let i = 0; i < QUERIES; i++) {
      const id = securedIds[i % (securedIds.length / 2)];
      await prisma.$transaction([
        prisma.$executeRaw`SELECT set_config('app.organization_id', ${orgA}, true)`,
        prisma.$queryRaw`SELECT value FROM spike_rls.secured WHERE id = ${id}::uuid`,
      ]);
    }
    const securedMs = performance.now() - securedStart;

    // Isolation: org A must not see org B's rows, and sees all of its own.
    const isolation = await prisma.$transaction([
      prisma.$executeRaw`SELECT set_config('app.organization_id', ${orgA}, true)`,
      prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM spike_rls.secured`,
      prisma.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) AS count FROM spike_rls.secured WHERE organization_id = ${orgB}::uuid`,
    ]);
    const ownRows = Number(isolation[1]?.[0]?.count ?? 0);
    const foreignRows = Number(isolation[2]?.[0]?.count ?? 0);

    const perQueryPlain = plainMs / QUERIES;
    const perQuerySecured = securedMs / QUERIES;
    process.stdout.write(
      `${JSON.stringify(
        {
          queries: QUERIES,
          plainMsPerQuery: Number(perQueryPlain.toFixed(3)),
          rlsBatchMsPerQuery: Number(perQuerySecured.toFixed(3)),
          overheadMsPerQuery: Number((perQuerySecured - perQueryPlain).toFixed(3)),
          overheadFactor: Number((perQuerySecured / perQueryPlain).toFixed(2)),
          isolation: {
            ownRowsVisible: ownRows,
            foreignRowsVisible: foreignRows,
            passed: ownRows === ROWS_PER_ORG && foreignRows === 0,
          },
        },
        null,
        2,
      )}\n`,
    );
    if (foreignRows !== 0 || ownRows !== ROWS_PER_ORG) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
    const owner = new Client({ connectionString: migratorUrl });
    await owner.connect();
    await owner.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await owner.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
