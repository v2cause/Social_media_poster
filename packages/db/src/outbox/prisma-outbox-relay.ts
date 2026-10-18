import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The relay of the transactional outbox (architecture 7.4, guide step 4.3). It runs as app_system
// across all workspaces. A batch claims pending events with FOR UPDATE SKIP LOCKED, hands each to
// dispatch and marks it processed only after dispatch succeeded, all in one transaction: two
// relays never take the same event, and an event whose job could not be added stays pending and
// waits a growing pause. Dispatch must be idempotent (deterministic job ids): when the commit
// fails after a successful dispatch, the next run sends the event again. While a batch comes
// back full and without a failure, the next batch follows in the same run (guide step 8.5), so a
// burst of events does not wait one tick per batch.

export interface PendingOutboxEvent {
  id: string;
  organizationId: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  /** Failed dispatches so far. */
  attempts: number;
  createdAt: Date;
}

export interface OutboxRelayReport {
  relayed: number;
  failed: number;
}

interface PendingRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  type: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

const DEFAULT_BATCH_SIZE = 100;
/** Batches per run: up to 1,000 events per tick of a second. */
const DEFAULT_MAX_BATCHES = 10;
const MAX_ERROR_LENGTH = 500;

/** 2, 4, 8 ... seconds, at most five minutes. */
const backoffSeconds = (attempts: number): number => Math.min(300, 2 ** Math.min(attempts, 9));

const errorText = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error').slice(0, MAX_ERROR_LENGTH);

type Dispatch = (event: PendingOutboxEvent) => Promise<void>;

export class PrismaOutboxRelay {
  constructor(
    private readonly system: SystemPrismaClient,
    private readonly options: { batchSize?: number; maxBatches?: number; timeoutMs?: number } = {},
  ) {}

  async relay(dispatch: Dispatch): Promise<OutboxRelayReport> {
    const limit = this.options.batchSize ?? DEFAULT_BATCH_SIZE;
    const report: OutboxRelayReport = { relayed: 0, failed: 0 };
    for (let batch = 0; batch < (this.options.maxBatches ?? DEFAULT_MAX_BATCHES); batch += 1) {
      const { relayed, failed } = await this.relayBatch(dispatch, limit);
      report.relayed += relayed;
      report.failed += failed;
      // A batch that was not full emptied the outbox for now; one with a failure leaves the rest
      // to the pause of the failed events instead of trying the next batch against the same fault.
      if (relayed + failed < limit || failed > 0) {
        break;
      }
    }
    return report;
  }

  /** One batch in one transaction. */
  private relayBatch(dispatch: Dispatch, limit: number): Promise<OutboxRelayReport> {
    return runInSystemScope(() =>
      this.system.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<PendingRow[]>`
            SELECT e.id, w.organization_id, e.workspace_id, e.type, e.payload, e.attempts, e.created_at
              FROM outbox_event e
              JOIN workspace w ON w.id = e.workspace_id
             WHERE e.processed_at IS NULL AND e.available_at <= now()
             ORDER BY e.available_at, e.id
             LIMIT ${limit}
               FOR UPDATE OF e SKIP LOCKED`;
          const relayed: string[] = [];
          let failed = 0;
          for (const row of rows) {
            try {
              await dispatch({
                id: row.id,
                organizationId: row.organization_id,
                workspaceId: row.workspace_id,
                type: row.type,
                payload: row.payload,
                attempts: row.attempts,
                createdAt: row.created_at,
              });
              relayed.push(row.id);
            } catch (error) {
              failed += 1;
              await tx.$executeRaw`
                UPDATE outbox_event
                   SET attempts = attempts + 1,
                       last_error = ${errorText(error)},
                       available_at = now() + make_interval(secs => ${backoffSeconds(row.attempts + 1)})
                 WHERE id = ${row.id}::uuid`;
            }
          }
          if (relayed.length > 0) {
            await tx.$executeRaw`UPDATE outbox_event SET processed_at = now() WHERE id = ANY(${relayed}::uuid[])`;
          }
          return { relayed: relayed.length, failed };
        },
        { timeout: this.options.timeoutMs ?? 15_000 },
      ),
    );
  }

  /** Removes processed events older than the given age (tick.maintenance); returns how many. */
  purgeProcessed(olderThanDays: number): Promise<number> {
    return runInSystemScope(
      () =>
        this.system.$executeRaw`
          DELETE FROM outbox_event
           WHERE processed_at IS NOT NULL AND processed_at < now() - make_interval(days => ${olderThanDays})`,
    );
  }
}
