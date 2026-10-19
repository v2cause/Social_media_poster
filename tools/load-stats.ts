// Prints the database view of a run of the load test (guide step 8.5, ADR 0041) as JSON: the due
// variants by status, their lag behind the due time, the publications per second, the attempts,
// the lag of the outbox and the metrics polls. With --wait-metrics it first waits until every
// published variant of the run has its first metrics poll, at most the given seconds; the polls
// run in the background, where k6 does not see them.
//
// Run from the repository root after k6, with the stack of the run:
//   pnpm load:stats --cadence-scale 3600 --wait-metrics 720

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { createSystemPrismaClient, loadRunReport } from '@smp/db';
import { z } from 'zod';

const POLL_MS = 15_000;

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_SYSTEM_URL: z.string().min(1, 'DATABASE_SYSTEM_URL is not set.'),
});

const argsSchema = z.object({
  fixture: z.string().min(1).default('tools/load/fixture.json'),
  /** ANALYTICS_CADENCE_SCALE of the run: the first metrics poll was due 1 h (X: 24 h) divided by it. */
  'cadence-scale': z.coerce.number().int().min(1).max(3_600).default(1),
  'wait-metrics': z.coerce.number().int().min(0).max(3_600).default(0),
});

const fixtureSchema = z.object({
  run: z.string().regex(/^[a-z0-9]{1,8}$/),
  dueAt: z.coerce.date(),
  spreadSeconds: z.number().int().min(0),
});

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  if (env.NODE_ENV === 'production') {
    throw new Error('The load test never reads production.');
  }
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string' },
      'cadence-scale': { type: 'string' },
      'wait-metrics': { type: 'string' },
    },
  });
  const args = argsSchema.parse(values);
  const window = fixtureSchema.parse(JSON.parse(readFileSync(args.fixture, 'utf8')));
  const system = createSystemPrismaClient(env.DATABASE_SYSTEM_URL);
  try {
    const deadline = Date.now() + args['wait-metrics'] * 1000;
    let report = await loadRunReport(system, window, args['cadence-scale']);
    for (;;) {
      const published = report.statuses['PUBLISHED'] ?? 0;
      const measured = report.metrics?.measured ?? 0;
      if (Date.now() >= deadline || (published > 0 && measured >= published)) {
        break;
      }
      process.stderr.write(`${String(measured)} of ${String(published)} published variants polled\n`);
      await sleep(POLL_MS);
      report = await loadRunReport(system, window, args['cadence-scale']);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await system.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
