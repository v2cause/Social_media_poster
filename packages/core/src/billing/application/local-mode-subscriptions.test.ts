import { describe, expect, it } from 'vitest';

import type { Plan } from '../domain/plan';
import type { SubscriptionReader } from '../ports/subscription-store';
import { EntitlementsService } from './entitlements';
import { LOCAL_MODE_LIMITS, LocalModeSubscriptionReader } from './local-mode-subscriptions';

const plan = (key: Plan['key'], position: number, active = true): Plan => ({
  key,
  position,
  active,
  priceLookupKey: key === 'trial' ? null : key,
  limits: {
    maxWorkspaces: 1,
    maxSocialAccounts: 1,
    maxMembers: 1,
    aiCreditsMicros: 1,
    aiOverageCapMicros: 0,
    scheduledPostsPerMonth: 1,
    storageBytes: 1,
    analyticsHistoryDays: 7,
    xBrowserAllowed: false,
    xApiSpendCapMicros: 0,
  },
});

const inner = (plans: Plan[]): SubscriptionReader => ({
  // A real reader would say the trial ended; the local reader never asks it.
  find: () => Promise.reject(new Error('not used')),
  plans: () => Promise.resolve(plans),
});

describe('LocalModeSubscriptionReader', () => {
  it('reads every organization as active, writable and without reachable limits', async () => {
    const service = new EntitlementsService({
      subscriptions: new LocalModeSubscriptionReader(
        inner([plan('trial', 0), plan('pro', 2), plan('agency', 3)]),
      ),
      clock: { now: () => new Date('2026-11-25T10:00:00Z') },
    });

    const entitlements = await service.assertWritable('org-1');

    expect(entitlements).toMatchObject({ status: 'ACTIVE', readOnly: false, readOnlyAt: null });
    expect(entitlements.plan.key).toBe('agency');
    expect(entitlements.limits).toMatchObject(LOCAL_MODE_LIMITS);
    await expect(service.assertWithin('org-1', 'maxWorkspaces', 999)).resolves.toBeUndefined();
  });

  it('keeps the X browser setting of the plan', async () => {
    const reader = new LocalModeSubscriptionReader(inner([plan('agency', 3)]));

    expect((await reader.find('org-1')).plan.limits.xBrowserAllowed).toBe(false);
  });

  it('falls back to the last active plan without an agency plan', async () => {
    const reader = new LocalModeSubscriptionReader(
      inner([plan('starter', 1), plan('pro', 2), plan('agency', 3, false)]),
    );

    expect((await reader.find('org-1')).plan.key).toBe('pro');
  });
});
