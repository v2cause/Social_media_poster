import { parseArgs } from 'node:util';

import { platformSchema } from '@smp/contracts';
import { z } from 'zod';

// The arguments of `pnpm drill` (guide step 8.7): which fault the drill of a runbook injects.

export const DRILL_USAGE = [
  'usage: drill <scenario> [options]',
  '  platform-outage --platform <P> [--status 503] [--minutes 20] [--organizations 6] [--due-posts 2]',
  '  token-wave --platform <P> [--minutes 20] [--organizations 6] [--due-posts 2]',
  '  xb-drift [--count 3]',
  '  xb-canary',
].join('\n');

const fixture = {
  platform: platformSchema,
  /** How long the mock accounts of the platform fail. */
  minutes: z.coerce.number().int().min(1).max(240).default(20),
  organizations: z.coerce.number().int().min(1).max(50).default(6),
  duePosts: z.coerce.number().int().min(1).max(20).default(2),
};

const drillSchema = z.discriminatedUnion('scenario', [
  z.object({
    scenario: z.literal('platform-outage'),
    ...fixture,
    status: z.coerce.number().int().min(500).max(599).default(503),
  }),
  z.object({ scenario: z.literal('token-wave'), ...fixture }),
  /** Three drifts within an hour open the circuit breaker of the X browser. */
  z.object({ scenario: z.literal('xb-drift'), count: z.coerce.number().int().min(1).max(10).default(3) }),
  z.object({ scenario: z.literal('xb-canary') }),
]);
export type Drill = z.output<typeof drillSchema>;

const OPTIONS = {
  platform: { type: 'string' },
  status: { type: 'string' },
  minutes: { type: 'string' },
  organizations: { type: 'string' },
  'due-posts': { type: 'string' },
  count: { type: 'string' },
} as const;

const parse = (argv: readonly string[]) =>
  parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });

/** The drill the arguments ask for; null for unknown scenarios, options or values. */
export function drillOf(argv: readonly string[]): Drill | null {
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
  const result = drillSchema.safeParse({
    scenario: positionals[0],
    platform: values.platform,
    status: values.status,
    minutes: values.minutes,
    organizations: values.organizations,
    duePosts: values['due-posts'],
    count: values.count,
  });
  return result.success ? result.data : null;
}
