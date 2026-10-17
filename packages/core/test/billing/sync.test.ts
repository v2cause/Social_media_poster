import { describe, expect, it } from 'vitest';

import { syncSubscription, type BillingState, type ReportedSubscription } from '../../src';

// Guide step 7.2: the state of a paid subscription, as the provider reports it after a webhook.

const now = new Date('2026-10-17T12:00:00Z');
const started = new Date('2026-10-01T08:00:00Z');

const trial: BillingState = {
  planKey: 'trial',
  status: 'TRIALING',
  trialEndsAt: new Date('2026-10-25T08:00:00Z'),
  stripeSubscriptionId: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  readOnlyAt: new Date('2026-10-25T08:00:00Z'),
  billingStartedAt: null,
};

const reported = (patch: Partial<ReportedSubscription>): ReportedSubscription => ({
  id: 'sub_1',
  status: 'ACTIVE',
  planKey: 'pro',
  currentPeriodStart: started,
  currentPeriodEnd: new Date('2026-11-01T08:00:00Z'),
  cancelAtPeriodEnd: false,
  startedAt: started,
  trialEnd: null,
  ...patch,
});

const changed = (outcome: ReturnType<typeof syncSubscription>) => {
  if (outcome.kind !== 'changed') {
    throw new Error(`ignored: ${outcome.reason}`);
  }
  return outcome;
};

describe('taking over a subscription from the provider', () => {
  it('ends the trial with the first paid subscription', () => {
    const { state } = changed(syncSubscription(trial, reported({}), now));

    expect(state).toMatchObject({
      planKey: 'pro',
      status: 'ACTIVE',
      stripeSubscriptionId: 'sub_1',
      trialEndsAt: null,
      readOnlyAt: null,
      billingStartedAt: started,
      currentPeriodEnd: new Date('2026-11-01T08:00:00Z'),
    });
  });

  it('leaves the trial as it was when the checkout did not go through', () => {
    expect(syncSubscription(trial, reported({ status: 'INCOMPLETE' }), now)).toEqual({
      kind: 'ignored',
      reason: 'not_started',
    });
    expect(syncSubscription(trial, reported({ status: 'INCOMPLETE_EXPIRED' }), now)).toEqual({
      kind: 'ignored',
      reason: 'not_started',
    });
  });

  it('follows upgrades and downgrades by the lookup key and keeps the plan for an unknown price', () => {
    const paid = changed(syncSubscription(trial, reported({}), now)).state;
    expect(changed(syncSubscription(paid, reported({ planKey: 'agency' }), now)).state.planKey).toBe(
      'agency',
    );
    expect(changed(syncSubscription(paid, reported({ planKey: 'starter' }), now)).state.planKey).toBe(
      'starter',
    );
    expect(changed(syncSubscription(paid, reported({ planKey: null }), now)).state.planKey).toBe('pro');
  });

  it('starts the grace period once and keeps its start while the payment stays overdue', () => {
    const paid = changed(syncSubscription(trial, reported({}), now)).state;
    const first = changed(syncSubscription(paid, reported({ status: 'PAST_DUE' }), now));
    expect(first.pastDueStarted).toBe(true);
    expect(first.state).toMatchObject({ pastDueSince: now, readOnlyAt: new Date('2026-10-24T12:00:00Z') });

    const later = new Date('2026-10-19T12:00:00Z');
    const again = changed(syncSubscription(first.state, reported({ status: 'PAST_DUE' }), later));
    expect(again.pastDueStarted).toBe(false);
    expect(again.state).toMatchObject({ pastDueSince: now, readOnlyAt: new Date('2026-10-24T12:00:00Z') });

    const paidAgain = changed(syncSubscription(again.state, reported({ status: 'ACTIVE' }), later)).state;
    expect(paidAgain).toMatchObject({ pastDueSince: null, readOnlyAt: null });
  });

  it('makes the organization read-only when the subscription ends, and keeps that moment', () => {
    const paid = changed(syncSubscription(trial, reported({}), now)).state;
    const canceled = changed(syncSubscription(paid, reported({ status: 'CANCELED' }), now)).state;
    expect(canceled.readOnlyAt).toEqual(now);

    const later = new Date('2026-10-20T00:00:00Z');
    expect(
      changed(syncSubscription(canceled, reported({ status: 'CANCELED' }), later)).state.readOnlyAt,
    ).toEqual(now);
  });

  it('ignores a late report of an old subscription, but takes a new one once the old one ended', () => {
    const paid = changed(syncSubscription(trial, reported({}), now)).state;
    expect(syncSubscription(paid, reported({ id: 'sub_0', status: 'CANCELED' }), now)).toEqual({
      kind: 'ignored',
      reason: 'other_subscription',
    });
    expect(syncSubscription(paid, reported({ id: 'sub_2' }), now)).toEqual({
      kind: 'ignored',
      reason: 'other_subscription',
    });

    const ended = changed(syncSubscription(paid, reported({ status: 'CANCELED' }), now)).state;
    const renewed = changed(
      syncSubscription(ended, reported({ id: 'sub_2', planKey: 'starter' }), now),
    ).state;
    expect(renewed).toMatchObject({ stripeSubscriptionId: 'sub_2', planKey: 'starter', readOnlyAt: null });
  });
});
