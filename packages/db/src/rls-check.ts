import { z } from 'zod';

// Checks the row-level security setup of a schema (guide step 1.2, architecture 6.3).
// Run by `pnpm check:rls` against the local database and by the integration tests in CI.

/** Tables without a tenant column that still hold tenant data. */
const TENANT_TABLES_BY_NAME = ['organization'];
const TENANT_COLUMNS = ['workspace_id', 'organization_id'];

export type RlsProblem = 'rls_disabled' | 'rls_not_forced' | 'no_policy' | 'context_without_nullif';

export interface RlsViolation {
  table: string;
  problem: RlsProblem;
  policy?: string;
}

/** The part of a pg client the check needs. */
export interface CatalogQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const tableRow = z.object({
  table_name: z.string(),
  rls_enabled: z.boolean(),
  rls_forced: z.boolean(),
  policy_count: z.number().int(),
});

const policyRow = z.object({
  table_name: z.string(),
  policy_name: z.string(),
  expression: z.string(),
});

// The deparsed form of NULLIF(current_setting('app.x', true), '') in pg_policies.
const GUARDED_SETTING = /NULLIF\(current_setting\('[^']*'::text, true\), ''::text\)/g;
const ANY_SETTING = /current_setting\(/g;

/**
 * Returns every table that holds tenant data without forced row-level security and a policy,
 * and every policy that reads the context without NULLIF(current_setting(name, true), '').
 */
export async function findRlsViolations(
  client: CatalogQueryable,
  schema = 'public',
): Promise<RlsViolation[]> {
  const tables = await client.query(
    `SELECT c.relname AS table_name,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            (SELECT count(*)::int FROM pg_policies p
              WHERE p.schemaname = n.nspname AND p.tablename = c.relname) AS policy_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND (c.relname = ANY($2::text[])
             OR EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                           AND a.attname = ANY($3::text[])))
      ORDER BY c.relname`,
    [schema, TENANT_TABLES_BY_NAME, TENANT_COLUMNS],
  );
  const policies = await client.query(
    `SELECT tablename AS table_name,
            policyname AS policy_name,
            coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expression
       FROM pg_policies
      WHERE schemaname = $1
      ORDER BY tablename, policyname`,
    [schema],
  );

  const violations: RlsViolation[] = [];
  for (const row of z.array(tableRow).parse(tables.rows)) {
    if (!row.rls_enabled) {
      violations.push({ table: row.table_name, problem: 'rls_disabled' });
    } else if (!row.rls_forced) {
      violations.push({ table: row.table_name, problem: 'rls_not_forced' });
    }
    if (row.policy_count === 0) {
      violations.push({ table: row.table_name, problem: 'no_policy' });
    }
  }
  for (const row of z.array(policyRow).parse(policies.rows)) {
    const settings = row.expression.match(ANY_SETTING)?.length ?? 0;
    const guarded = row.expression.match(GUARDED_SETTING)?.length ?? 0;
    if (guarded < settings) {
      violations.push({
        table: row.table_name,
        problem: 'context_without_nullif',
        policy: row.policy_name,
      });
    }
  }
  return violations;
}
