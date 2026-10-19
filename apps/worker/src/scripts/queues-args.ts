import { parseArgs } from 'node:util';

import { z } from 'zod';

import { ALL_QUEUES } from '../queue-names';

// The arguments of `pnpm queues` (guide step 8.7): what the operators look at or remove.

export const QUEUES_USAGE = [
  'usage: queues <command> [options]',
  '  counts                                 jobs of every queue by state',
  '  dead-letters [--limit 50]              the copies of publish jobs that failed for good',
  '  remove-dead-letters [--before <time>]  removes them; with --before only those failed before',
  '  failed --queue <name> [--limit 20]     failed jobs of a queue, without their data',
].join('\n');

const limit = (fallback: number) => z.coerce.number().int().min(1).max(1_000).default(fallback);

const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('counts') }),
  z.object({ command: z.literal('dead-letters'), limit: limit(50) }),
  z.object({
    command: z.literal('remove-dead-letters'),
    before: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value))
      .optional(),
  }),
  z.object({ command: z.literal('failed'), queue: z.enum(ALL_QUEUES), limit: limit(20) }),
]);
export type QueuesCommand = z.output<typeof commandSchema>;

const OPTIONS = {
  limit: { type: 'string' },
  before: { type: 'string' },
  queue: { type: 'string' },
} as const;

const parse = (argv: readonly string[]) =>
  parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });

/** The command the arguments ask for; null for unknown commands, options or values. */
export function queuesCommandOf(argv: readonly string[]): QueuesCommand | null {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    return null;
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1) {
    return null;
  }
  const result = commandSchema.safeParse({ command: positionals[0], ...values });
  return result.success ? result.data : null;
}
