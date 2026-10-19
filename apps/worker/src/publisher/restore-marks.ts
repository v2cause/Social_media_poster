import { parseArgs } from 'node:util';

import { z } from 'zod';

// The arguments of scripts/mark-open-attempts.ts (guide step 8.6, docs/runbooks/backup-restore.md):
// --since with the time the database was restored to, in ISO 8601 with its offset, for example
// 2026-10-19T01:57:53+00:00, the same value as the target of the recovery.

const sinceSchema = z.iso.datetime({ offset: true });

/** The time of the restore, or undefined unless the arguments name one that is not in the future. */
export function restoreSinceOf(args: readonly string[], now: Date): Date | undefined {
  let since: string | undefined;
  try {
    since = parseArgs({ args: [...args], options: { since: { type: 'string' } }, strict: true }).values.since;
  } catch {
    return undefined;
  }
  const parsed = sinceSchema.safeParse(since);
  if (!parsed.success) {
    return undefined;
  }
  const date = new Date(parsed.data);
  return date.getTime() <= now.getTime() ? date : undefined;
}
