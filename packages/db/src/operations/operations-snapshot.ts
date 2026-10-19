import { Platform } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// What the alerts of guide step 8.7 read from the database, across all tenants: variants whose
// job did not start, connections that need a new login, kill switches, the cost of the AI and
// the spend on X of the last 24 hours, the size of the media library and the WAL archiver. Every
// value is a count or a sum; no row of a tenant leaves the query.

/** A QUEUED variant counts as stuck when its job did not start within this time. */
export const STUCK_QUEUED_MINUTES = 10;

export interface OperationsCounts {
  stuckQueued: number;
  /** Every platform, with zero when none of its connections waits for a new login. */
  needsReauth: { platform: Platform; connections: number }[];
  /** The global flags; a flag set to false is a kill switch that is on. */
  globalFlags: { key: string; enabled: boolean }[];
  ai24h: {
    generations: number;
    refusals: number;
    costMicros: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  xSpend24hMicros: number;
  archiver: {
    archiveMode: boolean;
    archivedCount: number;
    failedCount: number;
    lastArchivedAt: Date | null;
    lastFailedAt: Date | null;
  };
}

interface AiRow {
  generations: bigint;
  refusals: bigint;
  cost: bigint;
  input: bigint;
  output: bigint;
  cache_read: bigint;
  cache_write: bigint;
}

interface ArchiverRow {
  archive_mode: string;
  archived_count: bigint;
  failed_count: bigint;
  last_archived_time: Date | null;
  last_failed_time: Date | null;
}

export function readOperationsCounts(system: SystemPrismaClient, now: Date): Promise<OperationsCounts> {
  const stuckBefore = new Date(now.getTime() - STUCK_QUEUED_MINUTES * 60_000);
  const dayBefore = new Date(now.getTime() - 24 * 60 * 60_000);
  return runInSystemScope(async () => {
    const [stuck] = await system.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM post_variant WHERE status = 'QUEUED' AND queued_at < ${stuckBefore}`;
    const reauth = await system.$queryRaw<{ platform: Platform; count: bigint }[]>`
      SELECT platform, count(*) AS count FROM social_connection
       WHERE status = 'NEEDS_REAUTH' GROUP BY platform`;
    const reauthOf = new Map(reauth.map((row) => [row.platform, Number(row.count)]));
    const flags = await system.$queryRaw<{ key: string; enabled: boolean }[]>`
      SELECT key, enabled FROM feature_flag
       WHERE organization_id IS NULL AND workspace_id IS NULL ORDER BY key`;
    const [ai] = await system.$queryRaw<AiRow[]>`
      SELECT count(*) AS generations,
             count(*) FILTER (WHERE outcome = 'REFUSED') AS refusals,
             COALESCE(sum(cost_micros), 0)::bigint AS cost,
             COALESCE(sum(input_tokens), 0)::bigint AS input,
             COALESCE(sum(output_tokens), 0)::bigint AS output,
             COALESCE(sum(cache_read_tokens), 0)::bigint AS cache_read,
             COALESCE(sum(cache_write_tokens), 0)::bigint AS cache_write
        FROM ai_generation WHERE created_at >= ${dayBefore}`;
    const [x] = await system.$queryRaw<{ spent: bigint }[]>`
      SELECT COALESCE(sum(cost_micros), 0)::bigint AS spent
        FROM api_cost_record WHERE platform = 'X' AND created_at >= ${dayBefore}`;
    const [archiver] = await system.$queryRaw<ArchiverRow[]>`
      SELECT current_setting('archive_mode') AS archive_mode, archived_count, failed_count,
             last_archived_time, last_failed_time
        FROM pg_stat_archiver`;
    return {
      stuckQueued: Number(stuck?.count ?? 0n),
      // A platform without such connections reports zero, so that the alert on a wave of new
      // logins has a value to compare with.
      needsReauth: Object.values(Platform).map((platform) => ({
        platform,
        connections: reauthOf.get(platform) ?? 0,
      })),
      globalFlags: flags,
      ai24h: {
        generations: Number(ai?.generations ?? 0n),
        refusals: Number(ai?.refusals ?? 0n),
        costMicros: Number(ai?.cost ?? 0n),
        inputTokens: Number(ai?.input ?? 0n),
        outputTokens: Number(ai?.output ?? 0n),
        cacheReadTokens: Number(ai?.cache_read ?? 0n),
        cacheWriteTokens: Number(ai?.cache_write ?? 0n),
      },
      xSpend24hMicros: Number(x?.spent ?? 0n),
      archiver: {
        archiveMode: archiver?.archive_mode === 'on' || archiver?.archive_mode === 'always',
        archivedCount: Number(archiver?.archived_count ?? 0n),
        failedCount: Number(archiver?.failed_count ?? 0n),
        lastArchivedAt: archiver?.last_archived_time ?? null,
        lastFailedAt: archiver?.last_failed_time ?? null,
      },
    };
  });
}

/** The bytes of the media library: the measured size once a file arrived, the announced before. */
export function readStorageBytes(system: SystemPrismaClient): Promise<number> {
  return runInSystemScope(async () => {
    const [row] = await system.$queryRaw<{ used: bigint }[]>`
      SELECT COALESCE(SUM(COALESCE(size_bytes, declared_size)), 0)::bigint AS used
        FROM media_asset WHERE deleted_at IS NULL AND status <> 'REJECTED'`;
    return Number(row?.used ?? 0n);
  });
}
