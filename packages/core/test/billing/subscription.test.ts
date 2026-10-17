import { describe, expect, it } from 'vitest';

import { graceEndOf, readOnlyAtOf, trialFrom, type AccessState } from '../../src';

// Guide step 7.4: from when an organization is read-only.

const now = new Date('2026-10-17T12:00:00Z');
const state = (patch: Partial<AccessState>): AccessState => ({
  status: 'ACTIVE',
  trialEndsAt: null,
  pastDueSince: null,
  stripeSubscriptionId: 'sub_1',
  ...patch,
});

describe('the access of a subscription', () => {
  it('gives a new organization 14 days and makes it read-only at their end', () => {
    expect(trialFrom(now)).toEqual({
      trialEndsAt: new Date('2026-10-31T12:00:00Z'),
      readOnlyAt: new Date('2026-10-31T12:00:00Z'),
    });
  });

  it('keeps a paid subscription writable and lets Stripe end its own trials', () => {
    expect(readOnlyAtOf(state({ status: 'ACTIVE' }), null, now)).toBeNull();
    expect(
      readOnlyAtOf(state({ status: 'TRIALING', trialEndsAt: new Date('2026-10-20T00:00:00Z') }), null, now),
    ).toBeNull();
    const ownTrial = state({
      status: 'TRIALING',
      trialEndsAt: new Date('2026-10-20T00:00:00Z'),
      stripeSubscriptionId: null,
    });
    expect(readOnlyAtOf(ownTrial, null, now)).toEqual(new Date('2026-10-20T00:00:00Z'));
  });

  it('leaves 7 days of grace after a payment failed', () => {
    const since = new Date('2026-10-15T09:00:00Z');
    expect(graceEndOf(since)).toEqual(new Date('2026-10-22T09:00:00Z'));
    expect(readOnlyAtOf(state({ status: 'PAST_DUE', pastDueSince: since }), null, now)).toEqual(
      new Date('2026-10-22T09:00:00Z'),
    );
    expect(readOnlyAtOf(state({ status: 'PAST_DUE' }), null, now)).toEqual(new Date('2026-10-24T12:00:00Z'));
  });

  it('makes an organization read-only at once when its subscription ended or never started', () => {
    for (const status of ['CANCELED', 'UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED', 'PAUSED'] as const) {
      expect(readOnlyAtOf(state({ status }), null, now), status).toEqual(now);
    }
  });

  it('keeps the moment an organization became read-only when the state is copied again', () => {
    const earlier = new Date('2026-10-10T08:00:00Z');
    expect(readOnlyAtOf(state({ status: 'CANCELED' }), earlier, now)).toEqual(earlier);
    // A grace period that ended stays ended at its end, not at the next copy.
    const since = new Date('2026-10-01T09:00:00Z');
    expect(
      readOnlyAtOf(state({ status: 'PAST_DUE', pastDueSince: since }), new Date('2026-10-08T09:00:00Z'), now),
    ).toEqual(new Date('2026-10-08T09:00:00Z'));
    // A planned moment in the future does not hold back one that has come already.
    expect(readOnlyAtOf(state({ status: 'CANCELED' }), new Date('2026-10-30T00:00:00Z'), now)).toEqual(now);
    // Paying again makes it writable, whatever came before.
    expect(readOnlyAtOf(state({ status: 'ACTIVE' }), earlier, now)).toBeNull();
  });
});
