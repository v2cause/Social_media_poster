// Rules of the token monitor (guide step 4.9, architecture 4.2): access that runs out within 14
// days is renewed where the platform allows it, otherwise the connection is EXPIRING and its
// managers are reminded 14, 7 and 1 days ahead, once per stage. After the access ran out the
// connection needs a new grant.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Access tokens that run out within this time are renewed before the platform is called. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const TOKEN_EXPIRY_WINDOW_MS = 14 * DAY_MS;

/** The stages of the reminder in days before the access runs out, most distant first. */
export const EXPIRY_NOTICE_DAYS = [14, 7, 1] as const;

/** Whether access that runs out then is inside the window. */
export const isInExpiryWindow = (expiresAt: Date | null, now: Date): boolean =>
  expiresAt !== null && expiresAt.getTime() - now.getTime() <= TOKEN_EXPIRY_WINDOW_MS;

/** The nearest stage the time left falls into; null when the access lasts longer or ran out. */
export function noticeStageOf(expiresAt: Date, now: Date): number | null {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) {
    return null;
  }
  const stages = EXPIRY_NOTICE_DAYS.filter((days) => left <= days * DAY_MS);
  return stages.length > 0 ? Math.min(...stages) : null;
}

/** A reminder of this stage is due when no nearer one went out yet. */
export const isNoticeDue = (stage: number, lastNoticeDays: number | null): boolean =>
  lastNoticeDays === null || stage < lastNoticeDays;

/** After a refresh: ACTIVE when the access lasts beyond the window, EXPIRING otherwise. */
export const statusAfterRefresh = (accessExpiresAt: Date | null, now: Date): 'ACTIVE' | 'EXPIRING' =>
  isInExpiryWindow(accessExpiresAt, now) ? 'EXPIRING' : 'ACTIVE';
