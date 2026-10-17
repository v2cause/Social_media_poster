import type { SocialAccountDto } from '@smp/contracts';

import type { VariantStatusDto } from '@/features/publishing/statuses';
import { localDateTimeOf } from '@/features/publishing/zoned-time';

// The rules of the schedule bar (guide step 4.11), after the use cases of guide step 4.6: which
// request plans a variant or posts it now in its status, when the content is locked, the time a
// new plan starts with, and what the bar says about the account of a variant.

/** Plan for a time: a draft or canceled variant anew, a planned or queued one moved, a failed one retried. */
export type PlanStep = 'schedule' | 'reschedule' | 'retry';
/** Post now: a draft, planned or canceled variant goes out at once; a failed one is retried now. */
export type NowStep = 'publish-now' | 'retry';

export function planStepOf(status: VariantStatusDto): PlanStep | null {
  switch (status) {
    case 'DRAFT':
    case 'CANCELED':
      return 'schedule';
    case 'SCHEDULED':
    case 'QUEUED':
      return 'reschedule';
    case 'FAILED':
      return 'retry';
    default:
      return null;
  }
}

export function nowStepOf(status: VariantStatusDto): NowStep | null {
  switch (status) {
    case 'DRAFT':
    case 'SCHEDULED':
    case 'CANCELED':
      return 'publish-now';
    case 'FAILED':
      return 'retry';
    default:
      return null;
  }
}

const EDITABLE: readonly VariantStatusDto[] = ['DRAFT', 'SCHEDULED', 'FAILED', 'CANCELED'];

/** The text and the media of a variant stay as they are while it goes out and after. */
export const isContentLocked = (status: VariantStatusDto): boolean => !EDITABLE.includes(status);

const QUARTER_MS = 15 * 60_000;
const LEAD_MS = 60 * 60_000;

/** The time a new plan suggests: at least an hour ahead, on a quarter hour, in the zone. */
export function defaultPlanTime(now: Date, timeZone: string): { date: string; time: string } {
  const at = new Date(Math.ceil((now.getTime() + LEAD_MS) / QUARTER_MS) * QUARTER_MS);
  const local = localDateTimeOf(at, timeZone);
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

export type AccountHint = 'needs-reauth' | 'expires-before' | 'expiring';

/**
 * What the bar says about the account of a variant: it must be connected again first, its access
 * ends before the planned time, or it ends soon.
 */
export function accountHintOf(
  account: Pick<SocialAccountDto, 'status' | 'accessExpiresAt'> | undefined,
  plannedAt: Date | null,
): AccountHint | null {
  if (!account) {
    return null;
  }
  if (account.status === 'NEEDS_REAUTH' || account.status === 'REVOKED' || account.status === 'PAUSED') {
    return 'needs-reauth';
  }
  if (
    account.accessExpiresAt !== null &&
    plannedAt !== null &&
    Date.parse(account.accessExpiresAt) <= plannedAt.getTime()
  ) {
    return 'expires-before';
  }
  return account.status === 'EXPIRING' ? 'expiring' : null;
}

/** An account a variant can be planned for. */
export const isUsable = (account: Pick<SocialAccountDto, 'status'>): boolean =>
  account.status === 'ACTIVE' || account.status === 'EXPIRING';

/**
 * The account a variant starts with in the bar: its own, else the only usable account of its
 * platform, else none.
 */
export function initialAccountOf(
  variant: { platform: SocialAccountDto['platform']; socialAccountId: string | null },
  accounts: readonly Pick<SocialAccountDto, 'id' | 'platform' | 'status'>[],
): string {
  if (variant.socialAccountId !== null) {
    return variant.socialAccountId;
  }
  const usable = accounts.filter((account) => account.platform === variant.platform && isUsable(account));
  const [only] = usable;
  return usable.length === 1 && only ? only.id : '';
}
