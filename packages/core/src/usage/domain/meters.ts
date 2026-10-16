// Metered usage (architecture 5.3): one counter per organization, meter and month, and a ledger
// entry per source. Quantities are integers; money in micro-USD (architecture 6.1).

export const USAGE_METERS = ['ai_micros'] as const;
export type UsageMeter = (typeof USAGE_METERS)[number];

/** The first day of the month of an instant, in UTC: the period of the counters. */
export const monthlyPeriodStart = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
