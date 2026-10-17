// Plans and their limits (guide step 7.1, ADR 0033). The price list lives in the table plan; the
// limits are the same keys as in @smp/contracts, which checks the JSON wherever it is read.

export const PLAN_KEYS = ['trial', 'starter', 'pro', 'agency'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export interface PlanLimits {
  maxWorkspaces: number;
  /** Connected accounts in all workspaces of the organization. */
  maxSocialAccounts: number;
  /** Members and open invitations. */
  maxMembers: number;
  /** AI usage included per calendar month (UTC), in micro-USD. */
  aiCreditsMicros: number;
  /** AI usage beyond the credits, billed through the meter; 0 stops at the credits. */
  aiOverageCapMicros: number;
  /** Posts that go out per calendar month (UTC), planned or published. */
  scheduledPostsPerMonth: number;
  /** The originals of the media library in all workspaces. */
  storageBytes: number;
  analyticsHistoryDays: number;
  xBrowserAllowed: boolean;
  /** X API costs per calendar month (UTC), in micro-USD. */
  xApiSpendCapMicros: number;
}

/** The limits a request can run into one at a time (PLAN_LIMIT_REACHED). */
export type CountedLimit = 'maxWorkspaces' | 'maxSocialAccounts' | 'maxMembers' | 'scheduledPostsPerMonth';

export interface Plan {
  key: PlanKey;
  limits: PlanLimits;
  /** The lookup key of its monthly price in Stripe; null for the trial. */
  priceLookupKey: string | null;
  position: number;
  active: boolean;
}

/** The limits of a plan with the overrides the operators set for one organization. */
export const effectiveLimits = (plan: PlanLimits, overrides: Partial<PlanLimits> | null): PlanLimits => ({
  ...plan,
  ...overrides,
});

/** AI usage an organization may reach in a month: the credits and, with a paid plan, the overage. */
export const aiCapMicros = (limits: PlanLimits): number => limits.aiCreditsMicros + limits.aiOverageCapMicros;
