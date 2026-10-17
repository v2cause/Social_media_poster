import type { Subscription, UsageBatch, UsageMeterName, UsageReportStore } from '@smp/core';

import { runInSystemScope, type SystemPrismaClient } from '../system-client';
import { toSubscription } from './prisma-subscriptions';

// The usage as the daily report reads and marks it (guide step 7.3, ADR 0035), as app_system,
// because the report runs for organization after organization: the AI ledger (usage_record,
// meter ai_micros) and the costs of the X API (api_cost_record, platform X). A batch is one meter
// and one month of an organization, claimed under the identifier of its meter event,
// {ai|x}.{organizationId}.{YYYY-MM}.{day of the report}, and marked once Stripe took it.

const AI_LEDGER_METER = 'ai_micros';

interface BatchRow {
  identifier: string;
  meter: UsageMeterName;
  period_start: Date;
  quantity: bigint;
  latest_at: Date;
}

/** A date column as the database compares it, without the time zone of the session. */
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

export class PrismaUsageReportStore implements UsageReportStore {
  constructor(private readonly system: SystemPrismaClient) {}

  async organizationsToReport(until: Date): Promise<string[]> {
    const rows = await runInSystemScope(
      () => this.system.$queryRaw<{ organization_id: string }[]>`
        SELECT s.organization_id FROM subscription s
        WHERE s.stripe_customer_id IS NOT NULL AND s.billing_started_at IS NOT NULL
          AND (EXISTS (SELECT 1 FROM usage_record u
                       WHERE u.organization_id = s.organization_id AND u.meter = ${AI_LEDGER_METER}
                         AND u.reported_to_stripe_at IS NULL
                         AND u.created_at >= s.billing_started_at AND u.created_at < ${until})
            OR EXISTS (SELECT 1 FROM api_cost_record a
                       WHERE a.organization_id = s.organization_id AND a.platform = 'X'
                         AND a.reported_to_stripe_at IS NULL
                         AND a.created_at >= s.billing_started_at AND a.created_at < ${until}))
        ORDER BY s.organization_id`,
    );
    return rows.map((row) => row.organization_id);
  }

  async subscriptionOf(organizationId: string): Promise<Subscription | null> {
    const row = await runInSystemScope(() =>
      this.system.subscription.findUnique({ where: { organizationId }, include: { plan: true } }),
    );
    return row ? toSubscription(row) : null;
  }

  async claim(organizationId: string, window: { from: Date; until: Date }): Promise<UsageBatch[]> {
    const day = dayOf(window.until);
    const rows = await runInSystemScope(() =>
      this.system.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE usage_record
          SET stripe_report_id = 'ai.' || organization_id || '.' || to_char(period_start, 'YYYY-MM') || '.' || ${day}
          WHERE organization_id = ${organizationId}::uuid AND meter = ${AI_LEDGER_METER}
            AND stripe_report_id IS NULL AND reported_to_stripe_at IS NULL
            AND created_at >= ${window.from} AND created_at < ${window.until}`;
        await tx.$executeRaw`
          UPDATE api_cost_record
          SET stripe_report_id =
            'x.' || organization_id || '.' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') || '.' || ${day}
          WHERE organization_id = ${organizationId}::uuid AND platform = 'X'
            AND stripe_report_id IS NULL AND reported_to_stripe_at IS NULL
            AND created_at >= ${window.from} AND created_at < ${window.until}`;
        return tx.$queryRaw<BatchRow[]>`
          SELECT stripe_report_id AS identifier, 'ai_overage'::text AS meter, period_start,
                 sum(quantity)::bigint AS quantity, max(created_at) AS latest_at
          FROM usage_record
          WHERE organization_id = ${organizationId}::uuid AND meter = ${AI_LEDGER_METER}
            AND stripe_report_id IS NOT NULL AND reported_to_stripe_at IS NULL
          GROUP BY stripe_report_id, period_start
          UNION ALL
          SELECT stripe_report_id, 'x_api_cost'::text, date_trunc('month', created_at AT TIME ZONE 'UTC')::date,
                 sum(cost_micros)::bigint, max(created_at)
          FROM api_cost_record
          WHERE organization_id = ${organizationId}::uuid AND platform = 'X'
            AND stripe_report_id IS NOT NULL AND reported_to_stripe_at IS NULL
          GROUP BY stripe_report_id, date_trunc('month', created_at AT TIME ZONE 'UTC')
          ORDER BY latest_at, identifier`;
      }),
    );
    return rows.map((row) => ({
      identifier: row.identifier,
      meter: row.meter,
      periodStart: row.period_start,
      quantity: row.quantity,
      latestAt: row.latest_at,
    }));
  }

  async creditedBefore(organizationId: string, batch: UsageBatch, billingStartedAt: Date): Promise<bigint> {
    const [row] = await runInSystemScope(
      () => this.system.$queryRaw<{ credited: bigint }[]>`
        SELECT coalesce(sum(quantity), 0)::bigint AS credited FROM usage_record
        WHERE organization_id = ${organizationId}::uuid AND meter = ${AI_LEDGER_METER}
          AND period_start = ${dayOf(batch.periodStart)}::date
          AND stripe_report_id IS DISTINCT FROM ${batch.identifier}
          AND (reported_to_stripe_at IS NOT NULL OR created_at < ${billingStartedAt})`,
    );
    return row?.credited ?? 0n;
  }

  async confirm(organizationId: string, batch: UsageBatch, at: Date): Promise<void> {
    await runInSystemScope(() =>
      batch.meter === 'ai_overage'
        ? this.system.$executeRaw`
            UPDATE usage_record SET reported_to_stripe_at = ${at}
            WHERE organization_id = ${organizationId}::uuid AND stripe_report_id = ${batch.identifier}
              AND reported_to_stripe_at IS NULL`
        : this.system.$executeRaw`
            UPDATE api_cost_record SET reported_to_stripe_at = ${at}
            WHERE organization_id = ${organizationId}::uuid AND stripe_report_id = ${batch.identifier}
              AND reported_to_stripe_at IS NULL`,
    );
  }
}
