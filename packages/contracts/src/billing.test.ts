import { describe, expect, it } from 'vitest';

import {
  checkoutRequestSchema,
  limitOverridesSchema,
  planLimitsSchema,
  portalRequestSchema,
} from './billing';

const limits = {
  maxWorkspaces: 3,
  maxSocialAccounts: 15,
  maxMembers: 10,
  aiCreditsMicros: 30_000_000,
  aiOverageCapMicros: 50_000_000,
  scheduledPostsPerMonth: 600,
  storageBytes: 25 * 1024 ** 3,
  analyticsHistoryDays: 365,
  xBrowserAllowed: true,
  xApiSpendCapMicros: 50_000_000,
};

describe('billing contracts', () => {
  it('takes the limits of a plan only complete and without unknown keys', () => {
    expect(planLimitsSchema.parse(limits)).toEqual(limits);
    const incomplete: Partial<typeof limits> = { ...limits };
    delete incomplete.maxMembers;
    expect(planLimitsSchema.safeParse(incomplete).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...limits, maxPosts: 10 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...limits, maxWorkspaces: 0 }).success).toBe(false);
    expect(planLimitsSchema.safeParse({ ...limits, storageBytes: 1.5 }).success).toBe(false);
  });

  it('overrides single limits, but no unknown ones', () => {
    expect(limitOverridesSchema.parse({ maxSocialAccounts: 200 })).toEqual({ maxSocialAccounts: 200 });
    expect(limitOverridesSchema.safeParse({ seats: 3 }).success).toBe(false);
  });

  it('sells only the paid plans and opens the portal for everything by default', () => {
    expect(checkoutRequestSchema.safeParse({ plan: 'pro' }).success).toBe(true);
    expect(checkoutRequestSchema.safeParse({ plan: 'trial' }).success).toBe(false);
    expect(portalRequestSchema.parse({})).toEqual({ flow: 'manage' });
  });
});
