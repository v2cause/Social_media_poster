import type { AnalyticsHistory } from '../../analytics/application/analytics-period';
import { PlatformError } from '../../channels/domain/platform-error';
import type { MediaLimits } from '../../media/application/dependencies';
import type { Clock } from '../../shared/ports/clock';
import type { QuotaLimits } from '../../usage/ports/quota-store';
import { assertWithinLimit } from '../domain/limits';
import { aiCapMicros } from '../domain/plan';
import type { PlanUsage } from '../ports/plan-usage';
import type { EntitlementsService } from './entitlements';

// The limits of the plan where the other modules check them (guide step 7.4, ADR 0035): the AI
// quota, the analytics history, the storage, the posts per month, the connected accounts and the
// X API costs, read from the subscription of the organization through the entitlements.

export type PlanEntitlements = Pick<EntitlementsService, 'of'>;

/** The AI usage an organization may reach in a month: the credits and the overage of its plan. */
export const planQuotaLimits = (entitlements: PlanEntitlements): QuotaLimits => ({
  limitOf: async (organizationId) => BigInt(aiCapMicros((await entitlements.of(organizationId)).limits)),
});

/** The days of analytics the plan of an organization keeps. */
export const planAnalyticsHistory = (entitlements: PlanEntitlements): AnalyticsHistory => ({
  daysOf: async (organizationId) => (await entitlements.of(organizationId)).limits.analyticsHistoryDays,
});

/** The storage the plan of an organization allows and what its workspaces store. */
export const planMediaLimits = (
  entitlements: PlanEntitlements,
  usage: Pick<PlanUsage, 'storageBytes'>,
): MediaLimits => ({
  storageBytes: async (organizationId) => (await entitlements.of(organizationId)).limits.storageBytes,
  storageUsed: (organizationId) => usage.storageBytes(organizationId),
});

/** The posts per month the plan of an organization allows. */
export interface PostLimits {
  /** Throws PlanLimitReachedError when one more post in the month of `at` goes beyond the plan. */
  assertRoom(organizationId: string, variantId: string, at: Date): Promise<void>;
}

export const planPostLimits = (
  entitlements: PlanEntitlements,
  usage: Pick<PlanUsage, 'postsInMonth'>,
): PostLimits => ({
  async assertRoom(organizationId, variantId, at) {
    const [{ limits }, used] = await Promise.all([
      entitlements.of(organizationId),
      usage.postsInMonth(organizationId, at, variantId),
    ]);
    assertWithinLimit(limits, 'scheduledPostsPerMonth', used);
  },
});

/** No limit: for tests and tools that plan without a subscription. */
export const unlimitedPosts: PostLimits = { assertRoom: () => Promise.resolve() };

/** The connected accounts the plan of an organization allows, in all its workspaces. */
export interface AccountLimits {
  /** Throws PlanLimitReachedError when connecting `adding` more accounts goes beyond the plan. */
  assertRoom(organizationId: string, adding: number): Promise<void>;
}

export const planAccountLimits = (
  entitlements: PlanEntitlements,
  usage: Pick<PlanUsage, 'socialAccounts'>,
): AccountLimits => ({
  async assertRoom(organizationId, adding) {
    if (adding <= 0) {
      return;
    }
    const [{ limits }, used] = await Promise.all([
      entitlements.of(organizationId),
      usage.socialAccounts(organizationId),
    ]);
    assertWithinLimit(limits, 'maxSocialAccounts', used, adding);
  },
});

/** No limit: for tests that connect accounts without a subscription. */
export const unlimitedAccounts: AccountLimits = { assertRoom: () => Promise.resolve() };

/** The X API costs the plan of an organization allows per calendar month (UTC). */
export interface XSpendCap {
  /**
   * Throws PlatformError SPEND_CAP_REACHED when a call that costs this much would pass the cap of
   * the month; nothing is sent then.
   */
  assertRoom(organizationId: string, costMicros: number): Promise<void>;
}

export const planXSpendCap = (
  entitlements: PlanEntitlements,
  usage: Pick<PlanUsage, 'xApiSpendMicros'>,
  clock: Clock,
): XSpendCap => ({
  async assertRoom(organizationId, costMicros) {
    if (costMicros <= 0) {
      return;
    }
    const [{ limits }, spent] = await Promise.all([
      entitlements.of(organizationId),
      usage.xApiSpendMicros(organizationId, clock.now()),
    ]);
    if (spent + costMicros > limits.xApiSpendCapMicros) {
      throw new PlatformError(
        'SPEND_CAP_REACHED',
        'The X API costs of this month reached the cap of the plan.',
      );
    }
  },
});
