// The usage billing of an organization (guide step 7.3, ADR 0035): the AI usage beyond the credits
// of its plan and the X API costs go to the meters of Stripe once a day. The credits apply per
// calendar month (UTC), so the overage of a batch depends on what the month used before it.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stripe takes meter events of the past 35 days; an older batch goes out as of 34 days ago. */
export const METER_EVENT_MAX_AGE_DAYS = 34;

/** The part of a batch beyond the credits of the month, given the usage that came before it. */
export function overageOf(before: bigint, quantity: bigint, credits: bigint): bigint {
  const beyond = (usage: bigint): bigint => (usage > credits ? usage - credits : 0n);
  return beyond(before + quantity) - beyond(before);
}

/** The midnight (UTC) up to which the report of a moment reports: the start of its day. */
export const reportCutoffOf = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** The moment a meter event carries: the newest usage of its batch, or as old as Stripe takes. */
export function meterTimestampOf(latestAt: Date, now: Date): Date {
  const earliest = now.getTime() - METER_EVENT_MAX_AGE_DAYS * DAY_MS;
  return latestAt.getTime() < earliest ? new Date(earliest) : latestAt;
}
