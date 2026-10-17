import { PlanLimitReachedError } from './errors';
import type { CountedLimit, PlanLimits } from './plan';

/**
 * Throws PlanLimitReachedError when adding to what is used goes beyond a counted limit of the plan.
 * Only new resources are checked: after a downgrade, what exists stays (guide step 7.4).
 */
export function assertWithinLimit(limits: PlanLimits, limit: CountedLimit, used: number, adding = 1): void {
  if (adding > 0 && used + adding > limits[limit]) {
    throw new PlanLimitReachedError(limit, limits[limit]);
  }
}
