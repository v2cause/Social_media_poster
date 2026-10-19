import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The database view of a run of the load test (guide step 8.5, ADR 0041), next to what k6
// measures through the API: the due variants of the run by status, how long after their due time
// they were queued and published, the publications per second, the attempts, the lag of the
// outbox, and the metrics polls of the published variants, which run in the background where k6
// does not see them. It reads across workspaces as app_system.

/** The run as the fixture describes it. */
export interface LoadRunWindow {
  run: string;
  dueAt: Date;
  spreadSeconds: number;
}

/** Seconds over the variants, events or polls of the run. */
export interface LoadDistribution {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  count: number;
}

export interface LoadRunReport {
  statuses: Record<string, number>;
  queuedAfterDue: LoadDistribution | null;
  publishedAfterDue: LoadDistribution | null;
  /** The publications from the first to the last second with one. */
  publishing: { first: Date; last: Date; perSecond: number; maxPerSecond: number } | null;
  attempts: Record<string, number>;
  /** From the creation of an event of the run to its relay; pending ones count until now. */
  outbox: (LoadDistribution & { pending: number }) | null;
  /**
   * The metrics polls since the due time. afterDue: the first poll of each variant after its first
   * step was due, 1 h (X: 24 h) after publishing divided by ANALYTICS_CADENCE_SCALE.
   */
  metrics: {
    measured: number;
    snapshots: number;
    first: Date;
    last: Date;
    perSecond: number;
    maxPerSecond: number;
    afterDue: LoadDistribution;
  } | null;
}

interface DistributionRow {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  count: number;
}

const distributionOf = (row: DistributionRow | undefined): LoadDistribution | null =>
  row && row.count > 0
    ? { p50: row.p50 ?? 0, p95: row.p95 ?? 0, p99: row.p99 ?? 0, max: row.max ?? 0, count: row.count }
    : null;

const countsOf = (rows: { key: string; n: number }[]): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.key, row.n]));

/** Seconds between the first and the last second with an event, both counted. */
const spanSeconds = (first: Date, last: Date): number => (last.getTime() - first.getTime()) / 1000 + 1;

export function loadRunReport(
  system: SystemPrismaClient,
  window: LoadRunWindow,
  cadenceScale: number,
): Promise<LoadRunReport> {
  const pattern = `load-${window.run}-%`;
  const from = window.dueAt;
  const to = new Date(from.getTime() + (window.spreadSeconds + 1) * 1000);
  return runInSystemScope(async () => {
    const statuses = await system.$queryRaw<{ key: string; n: number }[]>`
      SELECT v.status::text AS key, count(*)::int AS n
        FROM post_variant v JOIN workspace w ON w.id = v.workspace_id
       WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
       GROUP BY 1`;
    const [queued] = await system.$queryRaw<DistributionRow[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY x) AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY x) AS p99, max(x) AS max, count(*)::int AS count
        FROM (SELECT extract(epoch FROM v.queued_at - v.scheduled_at)::float8 AS x
                FROM post_variant v JOIN workspace w ON w.id = v.workspace_id
               WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
                 AND v.queued_at IS NOT NULL) t`;
    const [published] = await system.$queryRaw<DistributionRow[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY x) AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY x) AS p99, max(x) AS max, count(*)::int AS count
        FROM (SELECT extract(epoch FROM v.published_at - v.scheduled_at)::float8 AS x
                FROM post_variant v JOIN workspace w ON w.id = v.workspace_id
               WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
                 AND v.published_at IS NOT NULL) t`;
    const seconds = await system.$queryRaw<{ second: Date; n: number }[]>`
      SELECT date_trunc('second', v.published_at) AS second, count(*)::int AS n
        FROM post_variant v JOIN workspace w ON w.id = v.workspace_id
       WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
         AND v.published_at IS NOT NULL
       GROUP BY 1 ORDER BY 1`;
    const attempts = await system.$queryRaw<{ key: string; n: number }[]>`
      SELECT a.outcome::text AS key, count(*)::int AS n
        FROM publish_attempt a JOIN post_variant v ON v.id = a.variant_id JOIN workspace w ON w.id = v.workspace_id
       WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
       GROUP BY 1`;
    // The events of the run start with the claims, which the scheduler makes ahead of the due time.
    const [outbox] = await system.$queryRaw<(DistributionRow & { pending: number })[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY x) AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY x) AS p99, max(x) AS max, count(*)::int AS count,
             (count(*) FILTER (WHERE pending))::int AS pending
        FROM (SELECT extract(epoch FROM coalesce(e.processed_at, now()) - e.created_at)::float8 AS x,
                     e.processed_at IS NULL AS pending
                FROM outbox_event e JOIN workspace w ON w.id = e.workspace_id
               WHERE w.slug LIKE ${pattern} AND e.created_at >= ${from}::timestamptz - interval '2 minutes') t`;
    const [polls] = await system.$queryRaw<
      { snapshots: number; measured: number; first: Date | null; last: Date | null }[]
    >`
      SELECT count(*)::int AS snapshots, count(DISTINCT s.variant_id)::int AS measured,
             min(s.captured_at) AS first, max(s.captured_at) AS last
        FROM metric_snapshot s JOIN post_variant v ON v.id = s.variant_id JOIN workspace w ON w.id = v.workspace_id
       WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
         AND s.captured_at >= ${from}`;
    const [busiest] = await system.$queryRaw<{ n: number | null }[]>`
      SELECT max(n)::int AS n FROM (
        SELECT count(*) AS n
          FROM metric_snapshot s JOIN post_variant v ON v.id = s.variant_id JOIN workspace w ON w.id = v.workspace_id
         WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
           AND s.captured_at >= ${from}
         GROUP BY date_trunc('second', s.captured_at)) t`;
    const [firstPolls] = await system.$queryRaw<DistributionRow[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY x) AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY x) AS p99, max(x) AS max, count(*)::int AS count
        FROM (SELECT extract(epoch FROM min(s.captured_at) - v.published_at)::float8
                     - CASE WHEN v.platform = 'X' THEN 86400 ELSE 3600 END / ${cadenceScale}::float8 AS x
                FROM metric_snapshot s JOIN post_variant v ON v.id = s.variant_id JOIN workspace w ON w.id = v.workspace_id
               WHERE w.slug LIKE ${pattern} AND v.scheduled_at >= ${from} AND v.scheduled_at < ${to}
                 AND s.captured_at >= ${from}
               GROUP BY v.id, v.published_at, v.platform) t`;

    const firstSecond = seconds[0]?.second;
    const lastSecond = seconds.at(-1)?.second;
    const publishedCount = seconds.reduce((sum, row) => sum + row.n, 0);
    const afterDue = distributionOf(firstPolls);
    const outboxLag = distributionOf(outbox);
    return {
      statuses: countsOf(statuses),
      queuedAfterDue: distributionOf(queued),
      publishedAfterDue: distributionOf(published),
      publishing:
        firstSecond && lastSecond
          ? {
              first: firstSecond,
              last: lastSecond,
              perSecond: publishedCount / spanSeconds(firstSecond, lastSecond),
              maxPerSecond: Math.max(...seconds.map((row) => row.n)),
            }
          : null,
      attempts: countsOf(attempts),
      outbox: outbox && outboxLag ? { ...outboxLag, pending: outbox.pending } : null,
      metrics:
        polls?.first && polls.last && afterDue
          ? {
              measured: polls.measured,
              snapshots: polls.snapshots,
              first: polls.first,
              last: polls.last,
              perSecond: polls.snapshots / spanSeconds(polls.first, polls.last),
              maxPerSecond: busiest?.n ?? 0,
              afterDue,
            }
          : null,
    };
  });
}
