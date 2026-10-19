import { uuidV7Ids, type IdGenerator } from '@smp/core';

import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// After a restore to an earlier time T (guide step 8.6, ADR 0042, docs/runbooks/backup-restore.md):
// a variant the publisher still has to send may have gone out between T and the failure, which
// the restored database does not know. Each such variant gets an open attempt that started at T,
// as a crashed run leaves one behind. Its next run then looks on the platform for a post since T
// before it sends anything (architecture 7, step 4), so no post goes out twice. It reads and
// writes across workspaces as app_system, before the publishers start again.

/** The states in which the publisher sends a variant without anyone asking again. */
const PENDING_STATUSES = ['SCHEDULED', 'QUEUED', 'PUBLISHING', 'RETRYING'];
const BATCH_SIZE = 1_000;

export interface RestoreAttemptMarks {
  /** Variants that got an open attempt at T. */
  marked: number;
  /** Variants with an open attempt from T or earlier already: their reconcile looks back that far. */
  alreadyOpen: number;
}

interface PendingVariantRow {
  id: string;
  workspace_id: string;
  schedule_version: number;
  next_attempt: number;
  open: boolean;
}

export function markOpenAttemptsAfterRestore(
  system: SystemPrismaClient,
  since: Date,
  ids: IdGenerator = uuidV7Ids,
): Promise<RestoreAttemptMarks> {
  return runInSystemScope(async () => {
    const pending = await system.$queryRaw<PendingVariantRow[]>`
      SELECT v.id, v.workspace_id, v.schedule_version,
             coalesce(max(a.attempt_number) FILTER (WHERE a.schedule_version = v.schedule_version), 0)::int + 1
               AS next_attempt,
             coalesce(bool_or(a.outcome IN ('STARTED', 'UNKNOWN') AND a.started_at <= ${since}), false) AS open
        FROM post_variant v
        LEFT JOIN publish_attempt a ON a.variant_id = v.id AND a.workspace_id = v.workspace_id
       WHERE v.status::text = ANY (${PENDING_STATUSES})
       GROUP BY v.id, v.workspace_id, v.schedule_version`;
    const unmarked = pending.filter((row) => !row.open);
    let marked = 0;
    for (let start = 0; start < unmarked.length; start += BATCH_SIZE) {
      const { count } = await system.publishAttempt.createMany({
        data: unmarked.slice(start, start + BATCH_SIZE).map((row) => ({
          id: ids.newId(),
          workspaceId: row.workspace_id,
          variantId: row.id,
          scheduleVersion: row.schedule_version,
          attemptNumber: row.next_attempt,
          trigger: 'restore',
          outcome: 'STARTED' as const,
          leaseOwner: 'restore',
          startedAt: since,
        })),
        // A run that took the number meanwhile has an attempt of its own; the publishers should
        // not run yet, but the mark must not fail on them.
        skipDuplicates: true,
      });
      marked += count;
    }
    return { marked, alreadyOpen: pending.length - unmarked.length };
  });
}
