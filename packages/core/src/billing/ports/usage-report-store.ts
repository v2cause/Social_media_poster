import type { UsageMeterName } from './billing-gateway';
import type { Subscription } from './subscription-store';

// The usage as the daily report reads and marks it (guide step 7.3, ADR 0035), across
// organizations: the AI usage ledger and the X API costs.

/** Records of one meter and month, claimed under one identifier and sent as one meter event. */
export interface UsageBatch {
  /** The idempotency identifier of the meter event: the same batch is the same event. */
  identifier: string;
  meter: UsageMeterName;
  /** The calendar month (UTC) of the records, the month of the credits. */
  periodStart: Date;
  /** The sum of the records, in micro-USD. */
  quantity: bigint;
  /** The newest record of the batch. */
  latestAt: Date;
}

export interface UsageReportStore {
  /** The organizations with usage from before the cutoff that was billed and not reported yet. */
  organizationsToReport(until: Date): Promise<string[]>;
  subscriptionOf(organizationId: string): Promise<Subscription | null>;
  /**
   * Claims the records of the window that no report took yet, one batch per meter and month,
   * and returns every batch claimed and not yet confirmed, oldest first: those of an earlier
   * report that did not finish too.
   */
  claim(organizationId: string, window: { from: Date; until: Date }): Promise<UsageBatch[]>;
  /**
   * The AI usage of the month of a batch that counted against the credits before it: reported
   * already, or from before billing started.
   */
  creditedBefore(organizationId: string, batch: UsageBatch, billingStartedAt: Date): Promise<bigint>;
  /** Marks the records of a batch as reported. */
  confirm(organizationId: string, batch: UsageBatch, at: Date): Promise<void>;
}
