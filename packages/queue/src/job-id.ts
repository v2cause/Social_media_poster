// Job ids of the deduplicated jobs (architecture 7.4). BullMQ refuses custom ids with ":" (only a
// legacy form with exactly three segments passes), so the parts are joined with ".". Every id is
// built here; job-id.test.ts checks all builders.

const UNSAFE = /[:\s]/;

/** Joins the parts of a job id; a part may neither be empty nor contain ":" or white space. */
export function jobIdOf(prefix: string, ...parts: readonly (string | number)[]): string {
  const segments = [prefix, ...parts.map(String)];
  if (segments.some((segment) => segment.length === 0 || UNSAFE.test(segment))) {
    throw new RangeError(`A part of a ${prefix} job id is empty or contains ":" or white space.`);
  }
  return segments.join('.');
}

/** pub.{variantId}.{scheduleVersion}: one publish job per schedule version of a variant. */
export const publishJobId = (variantId: string, scheduleVersion: number): string =>
  jobIdOf('pub', variantId, scheduleVersion);

/** dead.pub.{variantId}.{scheduleVersion}: one copy per publish job that failed for good. */
export const publishDeadLetterId = (variantId: string, scheduleVersion: number): string =>
  jobIdOf('dead', publishJobId(variantId, scheduleVersion));

/** tok.{connectionId}: one waiting refresh per connection. */
export const tokenRefreshJobId = (connectionId: string): string => jobIdOf('tok', connectionId);

/** mp.{accountId}.{bucket}: the post metrics of an account, batched per time bucket. */
export const postMetricsJobId = (accountId: string, bucket: string): string =>
  jobIdOf('mp', accountId, bucket);

/** ma.{accountId}.{day}: the daily numbers of an account, once per local day. */
export const accountMetricsJobId = (accountId: string, day: string): string => jobIdOf('ma', accountId, day);

/** ru.{workspaceId}.{from}.{to}: the deduplication key of a rollup of these days. */
export const rollupKey = (workspaceId: string, from: string, to: string): string =>
  jobIdOf('ru', workspaceId, from, to);

/** ntf.{outboxId}: one notification per outbox event. */
export const notifyJobId = (outboxId: string): string => jobIdOf('ntf', outboxId);

/** ntf.{outboxId}.{userId}: one email per outbox event and recipient. */
export const notifyEmailJobId = (outboxId: string, userId: string): string =>
  jobIdOf('ntf', outboxId, userId);

/** stripe.{eventId}: Stripe sends an event again until it gets an answer. */
export const stripeJobId = (eventId: string): string => jobIdOf('stripe', eventId);

/** usage.{organizationId}.{day}: one usage report per organization and day. */
export const usageReportJobId = (organizationId: string, day: string): string =>
  jobIdOf('usage', organizationId, day);

/** gdpr.{requestId}: one job per export or erasure request. */
export const gdprJobId = (requestId: string): string => jobIdOf('gdpr', requestId);

/** gdpr.sweep: at most one waiting sweep of the role "gdpr". */
export const gdprSweepJobId = (): string => jobIdOf('gdpr', 'sweep');

/** xb.{op}.{id}.{v}: a command to the browser worker per target and call (guide step 6.2). */
export const xbJobId = (operation: string, targetId: string, version: string | number): string =>
  jobIdOf('xb', operation, targetId, version);
