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

/** tok.{connectionId}: one waiting refresh per connection. */
export const tokenRefreshJobId = (connectionId: string): string => jobIdOf('tok', connectionId);

/** mp.{accountId}.{bucket}: the post metrics of an account, batched per time bucket. */
export const postMetricsJobId = (accountId: string, bucket: string): string =>
  jobIdOf('mp', accountId, bucket);

/** ntf.{outboxId}: one notification per outbox event. */
export const notifyJobId = (outboxId: string): string => jobIdOf('ntf', outboxId);

/** stripe.{eventId}: Stripe sends an event again until it gets an answer. */
export const stripeJobId = (eventId: string): string => jobIdOf('stripe', eventId);

/** gdpr.{requestId}: one job per export or erasure request. */
export const gdprJobId = (requestId: string): string => jobIdOf('gdpr', requestId);

/** xb.{op}.{id}.{v}: a command to the browser worker per target and version. */
export const xbJobId = (operation: string, targetId: string, version: number): string =>
  jobIdOf('xb', operation, targetId, version);
