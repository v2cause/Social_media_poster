import type { AnalyticsScope, DueAccountDay, DueMetricsAccount, MetricsPlanScanner } from '@smp/core';

import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The scans of the analytics planner across workspaces (guide step 5.2, architecture 6.3): as
// app_system, returning ids and the workspace only. The jobs read everything else again in the
// tenant of their account. Deleted organizations are left alone until their erasure (step 8.2).

interface DueAccountRow {
  account_id: string;
  workspace_id: string;
  organization_id: string;
}

interface DueDayRow extends DueAccountRow {
  day: string;
}

interface RollupRow {
  workspace_id: string;
  organization_id: string;
  today: string;
}

/** The local hour from which the numbers of the day before are polled (architecture 8). */
const ACCOUNT_METRICS_HOUR = 3;

export class PrismaMetricsPlanScanner implements MetricsPlanScanner {
  constructor(private readonly system: SystemPrismaClient) {}

  async dueAccounts(now: Date, limit: number): Promise<DueMetricsAccount[]> {
    // The partial index on metrics_next_at for published variants finds the due ones.
    const rows = await runInSystemScope(
      () => this.system.$queryRaw<DueAccountRow[]>`
        SELECT v.social_account_id AS account_id, v.workspace_id, w.organization_id
          FROM post_variant v
          JOIN workspace w ON w.id = v.workspace_id
          JOIN organization o ON o.id = w.organization_id
         WHERE v.status = 'PUBLISHED'
           AND o.deleted_at IS NULL
           AND v.metrics_next_at <= ${now}::timestamptz
           AND v.social_account_id IS NOT NULL
         GROUP BY v.social_account_id, v.workspace_id, w.organization_id
         ORDER BY min(v.metrics_next_at)
         LIMIT ${limit}`,
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
    }));
  }

  async accountDaysDue(now: Date, limit: number): Promise<DueAccountDay[]> {
    // A time zone Postgres does not know would stop the whole scan, so such workspaces wait.
    const rows = await runInSystemScope(
      () => this.system.$queryRaw<DueDayRow[]>`
        SELECT a.id AS account_id, a.workspace_id, w.organization_id,
               to_char(l.local_day - 1, 'YYYY-MM-DD') AS day
          FROM social_account a
          JOIN social_connection c ON c.id = a.connection_id
          JOIN workspace w ON w.id = a.workspace_id
          JOIN organization o ON o.id = w.organization_id
          CROSS JOIN LATERAL (
            SELECT (${now}::timestamptz AT TIME ZONE w.timezone)::date AS local_day,
                   extract(hour FROM ${now}::timestamptz AT TIME ZONE w.timezone) AS local_hour
          ) l
         WHERE w.timezone IN (SELECT name FROM pg_timezone_names)
           AND o.deleted_at IS NULL
           AND a.disconnected_at IS NULL
           AND c.status IN ('ACTIVE', 'EXPIRING')
           AND l.local_hour >= ${ACCOUNT_METRICS_HOUR}
           AND NOT EXISTS (
             SELECT 1 FROM account_metric_snapshot s
              WHERE s.social_account_id = a.id AND s.day = l.local_day - 1)
         ORDER BY a.id
         LIMIT ${limit}`,
    );
    return rows.map((row) => ({
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
      day: row.day,
    }));
  }

  async rollupWorkspaces(now: Date): Promise<(AnalyticsScope & { today: string })[]> {
    const rows = await runInSystemScope(
      () => this.system.$queryRaw<RollupRow[]>`
        SELECT w.id AS workspace_id, w.organization_id,
               to_char((${now}::timestamptz AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today
          FROM workspace w
          JOIN organization o ON o.id = w.organization_id
         WHERE w.timezone IN (SELECT name FROM pg_timezone_names)
           AND o.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM social_account a WHERE a.workspace_id = w.id)
         ORDER BY w.id`,
    );
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      organizationId: row.organization_id,
      today: row.today,
    }));
  }
}
