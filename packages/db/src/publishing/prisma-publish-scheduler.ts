import { MISSED_WINDOW_MS } from '@smp/core';

import { Prisma } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The scans of the scheduler across all workspaces (guide step 4.7, architecture 7): due plans
// become QUEUED, plans overdue beyond the window fail with MISSED_WINDOW (unless the workspace
// posts them anyway), each change with its outbox event, all in one transaction with SKIP
// LOCKED, so two ticks at the same time take disjoint rows. The jobs are added after the commit.
// The plans of a read-only organization wait, neither queued nor missed, until it pays again
// (guide step 7.4).

export interface QueuedVariant {
  variantId: string;
  workspaceId: string;
  organizationId: string;
  scheduleVersion: number;
  scheduledAt: Date;
}

export interface MissedVariant {
  variantId: string;
  workspaceId: string;
  organizationId: string;
}

/** A variant the sweeper looks after: queued for long, publishing with an expired lease, or retrying for long. */
export interface StaleVariant {
  variantId: string;
  workspaceId: string;
  organizationId: string;
  scheduleVersion: number;
  status: 'QUEUED' | 'PUBLISHING' | 'RETRYING';
}

export interface PublishSchedulerOptions {
  batchSize?: number;
  /** Queue this much ahead of the planned time; the job waits with a delay. */
  leadMs?: number;
  missedWindowMs?: number;
}

interface QueuedRow {
  id: string;
  workspace_id: string;
  organization_id: string;
  schedule_version: number;
  scheduled_at: Date;
}

interface MissedRow {
  id: string;
  workspace_id: string;
  organization_id: string;
}

interface StaleRow extends MissedRow {
  schedule_version: number;
  status: StaleVariant['status'];
}

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_LEAD_MS = 30_000;
/** A queued variant without a running job for this long gets its job again. */
const QUEUED_STALE_MS = 2 * 60_000;
/** Longer than the longest backoff (2 h with jitter): a retrying variant without a job. */
const RETRYING_STALE_MS = 3 * 60 * 60_000;

const seconds = (ms: number): number => Math.round(ms / 1000);

/** The organization of the variant v is read-only now. */
const READ_ONLY_ORGANIZATION = Prisma.sql`
  SELECT 1 FROM workspace o JOIN subscription sub ON sub.organization_id = o.organization_id
   WHERE o.id = v.workspace_id AND sub.read_only_at <= now()`;

export class PrismaPublishScheduler {
  constructor(
    private readonly system: SystemPrismaClient,
    private readonly options: PublishSchedulerOptions = {},
  ) {}

  /** Fails the missed plans and queues the due ones; returns both, committed. */
  claimDue(): Promise<{ queued: QueuedVariant[]; missed: MissedVariant[] }> {
    const batch = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    const lead = seconds(this.options.leadMs ?? DEFAULT_LEAD_MS);
    const window = seconds(this.options.missedWindowMs ?? MISSED_WINDOW_MS);
    return runInSystemScope(() =>
      this.system.$transaction(async (tx) => {
        const missed = await tx.$queryRaw<MissedRow[]>`
          WITH missed AS (
            SELECT v.id
              FROM post_variant v
              LEFT JOIN workspace_settings s ON s.workspace_id = v.workspace_id
             WHERE v.status = 'SCHEDULED'
               AND v.scheduled_at < now() - make_interval(secs => ${window})
               AND COALESCE(s.missed_window_behavior, 'FAIL') = 'FAIL'
               AND NOT EXISTS (${READ_ONLY_ORGANIZATION})
             ORDER BY v.scheduled_at
             LIMIT ${batch}
               FOR UPDATE OF v SKIP LOCKED
          ), failed AS (
            UPDATE post_variant v
               SET status = 'FAILED', failure_code = 'MISSED_WINDOW', queued_at = NULL,
                   version = v.version + 1, updated_at = now()
              FROM missed
             WHERE v.id = missed.id
            RETURNING v.id, v.workspace_id, v.post_id, v.schedule_version
          ), events AS (
            INSERT INTO outbox_event (id, workspace_id, type, payload)
            SELECT gen_random_uuid(), f.workspace_id, 'variant.status',
                   jsonb_build_object('variantId', f.id, 'postId', f.post_id, 'status', 'FAILED',
                                      'scheduleVersion', f.schedule_version)
              FROM failed f
          ), notices AS (
            -- The author hears of it (guide step 4.9).
            INSERT INTO outbox_event (id, workspace_id, type, payload)
            SELECT gen_random_uuid(), f.workspace_id, 'notification.requested',
                   jsonb_build_object('type', 'publish-failed', 'variantId', f.id, 'failureCode', 'MISSED_WINDOW')
              FROM failed f
          )
          SELECT f.id, f.workspace_id, w.organization_id
            FROM failed f
            JOIN workspace w ON w.id = f.workspace_id`;

        const queued = await tx.$queryRaw<QueuedRow[]>`
          WITH due AS (
            SELECT v.id
              FROM post_variant v
             WHERE v.status = 'SCHEDULED'
               AND v.scheduled_at <= now() + make_interval(secs => ${lead})
               AND NOT EXISTS (${READ_ONLY_ORGANIZATION})
             ORDER BY v.scheduled_at
             LIMIT ${batch}
               FOR UPDATE SKIP LOCKED
          ), queued AS (
            UPDATE post_variant v
               SET status = 'QUEUED', queued_at = now(), version = v.version + 1, updated_at = now()
              FROM due
             WHERE v.id = due.id
            RETURNING v.id, v.workspace_id, v.post_id, v.schedule_version, v.scheduled_at
          ), events AS (
            INSERT INTO outbox_event (id, workspace_id, type, payload)
            SELECT gen_random_uuid(), q.workspace_id, 'variant.status',
                   jsonb_build_object('variantId', q.id, 'postId', q.post_id, 'status', 'QUEUED',
                                      'scheduleVersion', q.schedule_version)
              FROM queued q
          )
          SELECT q.id, q.workspace_id, w.organization_id, q.schedule_version, q.scheduled_at
            FROM queued q
            JOIN workspace w ON w.id = q.workspace_id
           ORDER BY q.scheduled_at`;

        return {
          missed: missed.map((row) => ({
            variantId: row.id,
            workspaceId: row.workspace_id,
            organizationId: row.organization_id,
          })),
          queued: queued.map((row) => ({
            variantId: row.id,
            workspaceId: row.workspace_id,
            organizationId: row.organization_id,
            scheduleVersion: row.schedule_version,
            scheduledAt: row.scheduled_at,
          })),
        };
      }),
    );
  }

  /** The variants whose job may be lost: the sweeper checks each one (tick.sweep-queued). */
  stale(): Promise<StaleVariant[]> {
    const batch = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    return runInSystemScope(async () => {
      const rows = await this.system.$queryRaw<StaleRow[]>`
        SELECT v.id, v.workspace_id, w.organization_id, v.schedule_version, v.status
          FROM post_variant v
          JOIN workspace w ON w.id = v.workspace_id
         WHERE (v.status = 'QUEUED' AND v.queued_at < now() - make_interval(secs => ${seconds(QUEUED_STALE_MS)}))
            OR (v.status = 'PUBLISHING' AND v.lease_until < now())
            OR (v.status = 'RETRYING' AND v.updated_at < now() - make_interval(secs => ${seconds(RETRYING_STALE_MS)}))
         ORDER BY v.id
         LIMIT ${batch}`;
      return rows.map((row) => ({
        variantId: row.id,
        workspaceId: row.workspace_id,
        organizationId: row.organization_id,
        scheduleVersion: row.schedule_version,
        status: row.status,
      }));
    });
  }
}
