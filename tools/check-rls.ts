// Checks that every table with tenant data has forced row-level security and a policy, and that
// every policy reads the context through NULLIF (guide step 1.2). Exits with code 1 otherwise.
//
// Run from the repository root after `pnpm build` and `pnpm db:migrate`: pnpm check:rls

import { findRlsViolations } from '@smp/db';
import { Client } from 'pg';

async function main(): Promise<void> {
  const url = process.env['MIGRATION_DATABASE_URL'];
  if (!url) {
    throw new Error('MIGRATION_DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const violations = await findRlsViolations(client);
    if (violations.length === 0) {
      process.stdout.write('Row-level security: every tenant table is covered.\n');
      return;
    }
    for (const violation of violations) {
      const policy = violation.policy ? ` (policy ${violation.policy})` : '';
      process.stderr.write(`${violation.table}: ${violation.problem}${policy}\n`);
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
