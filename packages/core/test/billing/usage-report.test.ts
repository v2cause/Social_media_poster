import { describe, expect, it } from 'vitest';

import { meterTimestampOf, overageOf, ReportUsage, reportCutoffOf } from '../../src';
import {
  FakeBillingGateway,
  MemorySubscriptions,
  MemoryUsageLedger,
  RecordingLock,
  subscriptionOf,
} from '../in-memory-billing';
import { MovingClock } from '../in-memory-publish-job';

// Guide step 7.3: once a day the AI usage beyond the credits of the plan and the X API costs go
// to the meters of Stripe, each batch with an identifier, and every record counts once.

const ORG = '0192f000-0000-7000-8000-000000000001';
const NOW = Date.parse('2026-10-17T00:07:00Z');
const UNTIL = new Date('2026-10-17T00:00:00Z');

describe('the usage billing', () => {
  it('bills the part of a batch beyond the credits of the month', () => {
    expect(overageOf(4n, 3n, 10n)).toBe(0n);
    expect(overageOf(8n, 5n, 10n)).toBe(3n);
    expect(overageOf(12n, 5n, 10n)).toBe(5n);
    expect(overageOf(0n, 0n, 10n)).toBe(0n);
    expect(overageOf(0n, 10n, 10n)).toBe(0n);
  });

  it('reports up to the midnight of the day and as far back as Stripe takes', () => {
    expect(reportCutoffOf(new Date('2026-10-17T23:59:59.999Z'))).toEqual(UNTIL);
    expect(reportCutoffOf(UNTIL)).toEqual(UNTIL);
    const now = new Date(NOW);
    expect(meterTimestampOf(new Date('2026-10-16T18:00:00Z'), now)).toEqual(new Date('2026-10-16T18:00:00Z'));
    expect(meterTimestampOf(new Date('2026-08-01T00:00:00Z'), now)).toEqual(new Date('2026-09-13T00:07:00Z'));
  });
});

const testbed = () => {
  const subscriptions = new MemorySubscriptions();
  const ledger = new MemoryUsageLedger(subscriptions);
  const gateway = new FakeBillingGateway();
  const lock = new RecordingLock();
  const clock = new MovingClock(NOW);
  // Starter: 10 USD of AI usage a month included.
  subscriptions.put(
    subscriptionOf(ORG, 'starter', {
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      billingStartedAt: new Date('2026-10-01T00:00:00Z'),
    }),
  );
  return {
    subscriptions,
    ledger,
    gateway,
    lock,
    clock,
    report: new ReportUsage({ store: ledger, gateway, lock, clock }),
  };
};

describe('ReportUsage', () => {
  it('sends the AI overage and the X costs of the days before, once', async () => {
    const { subscriptions, ledger, gateway, lock, report } = testbed();
    subscriptions.put(
      subscriptionOf(ORG, 'starter', {
        stripeCustomerId: 'cus_1',
        billingStartedAt: new Date('2026-10-10T00:00:00Z'),
      }),
    );
    // In the trial before the plan was bought: counts against the credits, billed never.
    ledger.add(ORG, 'ai_overage', 4_000_000n, '2026-10-05T09:00:00Z');
    ledger.add(ORG, 'ai_overage', 5_000_000n, '2026-10-12T08:00:00Z');
    ledger.add(ORG, 'ai_overage', 3_000_000n, '2026-10-16T21:00:00Z');
    ledger.add(ORG, 'x_api_cost', 15_000n, '2026-10-16T22:00:00Z');
    // Today: the report of tomorrow takes it.
    ledger.add(ORG, 'ai_overage', 1_000_000n, '2026-10-17T00:01:00Z');

    await expect(report.execute({ organizationId: ORG, until: UNTIL })).resolves.toEqual({
      batches: 2,
      sent: 2,
    });
    await expect(report.execute({ organizationId: ORG, until: UNTIL })).resolves.toEqual({
      batches: 0,
      sent: 0,
    });

    expect(gateway.usage).toEqual([
      {
        meter: 'ai_overage',
        customerId: 'cus_1',
        // 12 USD in October, 10 included: the 8 billed since the plan cross the credits by 2.
        value: 2_000_000n,
        identifier: `ai.${ORG}.2026-10.2026-10-17`,
        timestamp: new Date('2026-10-16T21:00:00Z'),
      },
      {
        meter: 'x_api_cost',
        customerId: 'cus_1',
        value: 15_000n,
        identifier: `x.${ORG}.2026-10.2026-10-17`,
        timestamp: new Date('2026-10-16T22:00:00Z'),
      },
    ]);
    expect(lock.keys).toEqual([`usage.${ORG}`, `usage.${ORG}`]);
  });

  it('counts what the month reported before against the credits', async () => {
    const { ledger, gateway, clock, report } = testbed();
    ledger.add(ORG, 'ai_overage', 6_000_000n, '2026-10-15T10:00:00Z');
    await report.execute({ organizationId: ORG, until: new Date('2026-10-16T00:00:00Z') });
    ledger.add(ORG, 'ai_overage', 3_000_000n, '2026-10-16T10:00:00Z');
    await report.execute({ organizationId: ORG, until: UNTIL });
    clock.advance(24 * 60 * 60 * 1000);
    ledger.add(ORG, 'ai_overage', 2_000_000n, '2026-10-17T10:00:00Z');
    await report.execute({ organizationId: ORG, until: new Date('2026-10-18T00:00:00Z') });

    // 6 and 3 stay within the 10 included; the next 2 cross them by 1.
    expect(gateway.usage.map((event) => [event.identifier.slice(-10), event.value])).toEqual([
      ['2026-10-18', 1_000_000n],
    ]);
    expect(ledger.records.every((record) => record.reportedAt !== null)).toBe(true);
  });

  it('sends a batch again with its identifier when the report before did not finish', async () => {
    const { ledger, gateway, clock, report } = testbed();
    ledger.add(ORG, 'x_api_cost', 15_000n, '2026-10-16T10:00:00Z');
    gateway.failUsage = true;
    await expect(report.execute({ organizationId: ORG, until: UNTIL })).rejects.toThrow('provider away');
    expect(ledger.records[0]).toMatchObject({ reportId: `x.${ORG}.2026-10.2026-10-17`, reportedAt: null });

    clock.advance(24 * 60 * 60 * 1000);
    ledger.add(ORG, 'x_api_cost', 5_000n, '2026-10-17T10:00:00Z');
    await expect(
      report.execute({ organizationId: ORG, until: new Date('2026-10-18T00:00:00Z') }),
    ).resolves.toEqual({ batches: 2, sent: 2 });

    expect(gateway.usage.map((event) => [event.identifier, event.value])).toEqual([
      [`x.${ORG}.2026-10.2026-10-17`, 15_000n],
      [`x.${ORG}.2026-10.2026-10-18`, 5_000n],
    ]);
  });

  it('marks a batch within the credits as reported without sending it', async () => {
    const { ledger, gateway, report } = testbed();
    ledger.add(ORG, 'ai_overage', 1_000_000n, '2026-10-16T10:00:00Z');

    await expect(report.execute({ organizationId: ORG, until: UNTIL })).resolves.toEqual({
      batches: 1,
      sent: 0,
    });
    expect(gateway.usage).toEqual([]);
    expect(ledger.records[0]?.reportedAt).toEqual(new Date(NOW));
  });

  it('reports nothing for an organization that pays nothing', async () => {
    const { subscriptions, ledger, gateway, report } = testbed();
    subscriptions.put(subscriptionOf(ORG, 'trial', { status: 'TRIALING' }));
    ledger.add(ORG, 'ai_overage', 3_000_000n, '2026-10-16T10:00:00Z');

    await expect(ledger.organizationsToReport(UNTIL)).resolves.toEqual([]);
    await expect(report.execute({ organizationId: ORG, until: UNTIL })).resolves.toEqual({
      batches: 0,
      sent: 0,
    });
    expect(gateway.usage).toEqual([]);
  });

  it('applies the credits an operator set for the organization', async () => {
    const { subscriptions, ledger, gateway, report } = testbed();
    subscriptions.put(
      subscriptionOf(ORG, 'starter', {
        stripeCustomerId: 'cus_1',
        billingStartedAt: new Date('2026-10-01T00:00:00Z'),
        limitOverrides: { aiCreditsMicros: 1_000_000 },
      }),
    );
    ledger.add(ORG, 'ai_overage', 3_000_000n, '2026-10-16T10:00:00Z');

    await report.execute({ organizationId: ORG, until: UNTIL });
    expect(gateway.usage.map((event) => event.value)).toEqual([2_000_000n]);
  });
});
