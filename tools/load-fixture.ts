// Writes the data of the load test (guide step 8.5, ADR 0040) and the file the k6 script reads:
// per organization a workspace with its owner, the demo history of 90 days and posts due in the
// same minute on its four mock accounts. The owners sign in with SEED_USER_PASSWORD. Only for a
// stack of its own outside production: the data stay until the stack goes.
//
// Run from the repository root after `pnpm build`:
//   pnpm load:fixture --organizations 250 --due-posts 10 --due-in 5 --latency 500

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { createPrismaClient, loadFixtureOptionsSchema, seedLoadFixture } from '@smp/db';
import { z } from 'zod';

const MINUTE_MS = 60_000;

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_SYSTEM_URL: z.string().min(1, 'DATABASE_SYSTEM_URL is not set.'),
  SEED_USER_PASSWORD: z.string().min(12, 'SEED_USER_PASSWORD must be set and at least 12 characters long.'),
});

const argsSchema = z.object({
  run: z.string().optional(),
  organizations: z.coerce.number().default(250),
  'due-posts': z.coerce.number().default(10),
  /** Minutes until the posts fall due; k6 needs the time to sign in and to read before. */
  'due-in': z.coerce.number().int().min(2).max(60).default(5),
  spread: z.coerce.number().default(0),
  latency: z.coerce.number().default(500),
  out: z.string().min(1).default('tools/load/fixture.json'),
});

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  if (env.NODE_ENV === 'production') {
    throw new Error('The load test never writes into production.');
  }
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      organizations: { type: 'string' },
      'due-posts': { type: 'string' },
      'due-in': { type: 'string' },
      spread: { type: 'string' },
      latency: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const args = argsSchema.parse(values);
  const now = new Date();
  const options = loadFixtureOptionsSchema.parse({
    run: args.run ?? now.getTime().toString(36).slice(-6),
    organizations: args.organizations,
    duePostsPerWorkspace: args['due-posts'],
    // The start of the minute, so that "in the same minute" holds for every spread.
    dueAt: new Date(Math.ceil((now.getTime() + args['due-in'] * MINUTE_MS) / MINUTE_MS) * MINUTE_MS),
    spreadSeconds: args.spread,
    latencyMs: args.latency,
    now,
  });

  const prisma = createPrismaClient(env.DATABASE_SYSTEM_URL);
  try {
    const fixture = await seedLoadFixture(prisma, options, env.SEED_USER_PASSWORD, (written) => {
      process.stdout.write(`${String(written)} of ${String(options.organizations)} organizations written\n`);
    });
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stdout.write(
      `Run ${fixture.run}: ${String(fixture.dueVariants)} variants due at ${fixture.dueAt}, described in ${args.out}.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
