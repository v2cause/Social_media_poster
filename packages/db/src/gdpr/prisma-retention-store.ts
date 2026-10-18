import type { RetentionStore } from '@smp/core';

import { Prisma } from '../generated/prisma/client';
import { runInSystemScope, type SystemPrismaClient } from '../system-client';

// The retention periods on PostgreSQL (guide step 8.3, ADR 0038), as app_system across
// organizations. Every statement picks at most limit rows in a subquery, so that no statement
// holds its locks for long. The daily tables are compared by the UTC day of the moment. The
// counters of the rate limits have no index: Better Auth updates them with every request to
// /api/auth, and an index on the time of the last request would cost each of those updates more
// than a scan of the small table costs the night.

export class PrismaRetentionStore implements RetentionStore {
  constructor(private readonly system: SystemPrismaClient) {}

  clearAiRawData(createdBefore: Date, limit: number): Promise<number> {
    return runInSystemScope(
      () => this.system.$executeRaw`
        UPDATE ai_generation SET input = NULL, output = NULL
         WHERE id IN (
           SELECT id FROM ai_generation
            WHERE created_at < ${createdBefore} AND (input IS NOT NULL OR output IS NOT NULL)
            LIMIT ${limit})`,
    );
  }

  deleteProcessedWebhooks(processedBefore: Date, limit: number): Promise<number> {
    return runInSystemScope(
      () => this.system.$executeRaw`
        DELETE FROM webhook_event
         WHERE id IN (SELECT id FROM webhook_event WHERE processed_at < ${processedBefore} LIMIT ${limit})`,
    );
  }

  clearConnectionData(before: Date, limit: number): Promise<number> {
    return runInSystemScope(async () => {
      const audit = await this.system.$executeRaw`
        UPDATE audit_log SET ip_address = NULL, user_agent = NULL
         WHERE id IN (
           SELECT id FROM audit_log
            WHERE created_at < ${before} AND (ip_address IS NOT NULL OR user_agent IS NOT NULL)
            LIMIT ${limit})`;
      const sessions = await this.system.$executeRaw`
        DELETE FROM session
         WHERE id IN (SELECT id FROM session WHERE expires_at < ${before} LIMIT ${limit})`;
      // Better Auth keeps the time of the last request in milliseconds since the epoch.
      const rateLimits = await this.system.$executeRaw`
        DELETE FROM rate_limit
         WHERE id IN (SELECT id FROM rate_limit WHERE last_request < ${BigInt(before.getTime())} LIMIT ${limit})`;
      return audit + sessions + rateLimits;
    });
  }

  async organizations(after: string | null, limit: number): Promise<string[]> {
    const rows = await runInSystemScope(() =>
      this.system.organization.findMany({
        where: { workspaces: { some: {} }, ...(after === null ? {} : { id: { gt: after } }) },
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      }),
    );
    return rows.map((row) => row.id);
  }

  deleteMetrics(organizationId: string, before: Date, limit: number): Promise<number> {
    const workspaces = Prisma.sql`SELECT id FROM workspace WHERE organization_id = ${organizationId}::uuid`;
    return runInSystemScope(async () => {
      const snapshots = await this.system.$executeRaw`
        DELETE FROM metric_snapshot
         WHERE id IN (
           SELECT id FROM metric_snapshot
            WHERE workspace_id IN (${workspaces}) AND captured_at < ${before}
            LIMIT ${limit})`;
      const accounts = await this.system.$executeRaw`
        DELETE FROM account_metric_snapshot
         WHERE id IN (
           SELECT id FROM account_metric_snapshot
            WHERE workspace_id IN (${workspaces}) AND day < ${before}::date
            LIMIT ${limit})`;
      const daily = await this.system.$executeRaw`
        DELETE FROM analytics_daily
         WHERE (social_account_id, day) IN (
           SELECT social_account_id, day FROM analytics_daily
            WHERE workspace_id IN (${workspaces}) AND day < ${before}::date
            LIMIT ${limit})`;
      return snapshots + accounts + daily;
    });
  }
}
