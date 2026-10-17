import type { Clock } from '../../shared/ports/clock';
import { effectiveLimits } from '../domain/plan';
import { meterTimestampOf, overageOf } from '../domain/usage';
import type { BillingGateway } from '../ports/billing-gateway';
import type { BillingLock } from '../ports/billing-store';
import type { UsageReportStore } from '../ports/usage-report-store';

// The daily usage report of an organization (guide step 7.3, ADR 0035). It claims the records
// since the start of billing up to the cutoff into batches, sends each batch as a meter event
// with its identifier, then marks its records as reported. A report that runs again finds the
// batches it claimed and sends them with the same identifiers, which Stripe counts once.

export interface UsageReportDependencies {
  store: UsageReportStore;
  gateway: Pick<BillingGateway, 'reportUsage'>;
  lock: BillingLock;
  clock: Clock;
}

export interface UsageReportResult {
  /** The batches of the report, also those without anything to bill. */
  batches: number;
  /** The meter events sent. */
  sent: number;
}

export class ReportUsage {
  constructor(private readonly deps: UsageReportDependencies) {}

  /** Reports the usage of an organization from before the cutoff, one organization at a time. */
  execute(request: { organizationId: string; until: Date }): Promise<UsageReportResult> {
    return this.deps.lock.run(`usage.${request.organizationId}`, () => this.report(request));
  }

  private async report({
    organizationId,
    until,
  }: {
    organizationId: string;
    until: Date;
  }): Promise<UsageReportResult> {
    const { store, gateway, clock } = this.deps;
    const subscription = await store.subscriptionOf(organizationId);
    const customerId = subscription?.stripeCustomerId;
    const billingStartedAt = subscription?.billingStartedAt;
    if (!subscription || !customerId || !billingStartedAt) {
      return { batches: 0, sent: 0 };
    }
    const credits = BigInt(
      effectiveLimits(subscription.plan.limits, subscription.limitOverrides).aiCreditsMicros,
    );
    const batches = await store.claim(organizationId, { from: billingStartedAt, until });
    let sent = 0;
    for (const batch of batches) {
      // The AI usage is billed beyond the credits of its month; the costs of X are passed on.
      const value =
        batch.meter === 'ai_overage'
          ? overageOf(
              await store.creditedBefore(organizationId, batch, billingStartedAt),
              batch.quantity,
              credits,
            )
          : batch.quantity;
      if (value > 0n) {
        await gateway.reportUsage({
          meter: batch.meter,
          customerId,
          value,
          identifier: batch.identifier,
          timestamp: meterTimestampOf(batch.latestAt, clock.now()),
        });
        sent += 1;
      }
      await store.confirm(organizationId, batch, clock.now());
    }
    return { batches: batches.length, sent };
  }
}
