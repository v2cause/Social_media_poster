import { dailyEngagementRateOf, type DailyMetrics } from '@smp/core';

// The CSV export of the analytics (guide step 5.4): one row per account and day of the rollup.
// Fields with a separator, a quote or a line break are quoted; a text that starts like a formula
// gets a leading apostrophe, so a spreadsheet shows it instead of running it.

export const CSV_HEADER = [
  'day',
  'platform',
  'account',
  'impressions',
  'post_reach',
  'views',
  'likes',
  'comments',
  'shares',
  'clicks',
  'saves',
  'engagements',
  'engagement_rate',
  'posts_published',
  'followers',
  'account_reach',
  'profile_views',
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

/** A text field, quoted where needed and defused where it starts like a formula. */
export function csvText(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** A number field; empty for a metric that is not reported. */
const csvNumber = (value: number | null, digits?: number): string =>
  value === null ? '' : digits === undefined ? String(value) : value.toFixed(digits);

export const csvLine = (fields: readonly string[]): string => `${fields.join(',')}\r\n`;

export function csvRow(row: DailyMetrics & { accountName: string }): string {
  return csvLine([
    row.day,
    row.platform,
    csvText(row.accountName),
    csvNumber(row.impressions),
    csvNumber(row.postReach),
    csvNumber(row.views),
    csvNumber(row.likes),
    csvNumber(row.comments),
    csvNumber(row.shares),
    csvNumber(row.clicks),
    csvNumber(row.saves),
    csvNumber(row.engagements),
    csvNumber(dailyEngagementRateOf([row]), 6),
    String(row.postsPublished),
    csvNumber(row.followers),
    csvNumber(row.accountReach),
    csvNumber(row.profileViews),
  ]);
}
