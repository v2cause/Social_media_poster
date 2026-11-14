import { describe, expect, it } from 'vitest';

import {
  changePlanRequestSchema,
  checkoutRequestSchema,
  isUnlimitedLimit,
  limitOverridesSchema,
  planLimitsSchema,
  UNLIMITED_PLAN_LIMITS,
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

  it('sells and changes to the paid plans only', () => {
    expect(checkoutRequestSchema.safeParse({ plan: 'pro' }).success).toBe(true);
    expect(checkoutRequestSchema.safeParse({ plan: 'trial' }).success).toBe(false);
    expect(changePlanRequestSchema.safeParse({ plan: 'agency' }).success).toBe(true);
    expect(changePlanRequestSchema.safeParse({}).success).toBe(false);
  });

  it('takes the unlimited limits as overrides, each at the largest value it may take', () => {
    expect(limitOverridesSchema.parse(UNLIMITED_PLAN_LIMITS)).toEqual(UNLIMITED_PLAN_LIMITS);
    expect(planLimitsSchema.safeParse({ ...UNLIMITED_PLAN_LIMITS, maxWorkspaces: 10_001 }).success).toBe(
      false,
    );
    expect(
      planLimitsSchema.safeParse({ ...UNLIMITED_PLAN_LIMITS, analyticsHistoryDays: 3_651 }).success,
    ).toBe(false);
    expect(UNLIMITED_PLAN_LIMITS.aiOverageCapMicros).toBe(0);
  });

  it('tells an unlimited limit from a large one', () => {
    expect(isUnlimitedLimit('maxSocialAccounts', 100_000)).toBe(true);
    expect(isUnlimitedLimit('maxSocialAccounts', 75)).toBe(false);
    expect(isUnlimitedLimit('storageBytes', 100 * 1024 ** 3)).toBe(false);
    expect(isUnlimitedLimit('aiCreditsMicros', Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
