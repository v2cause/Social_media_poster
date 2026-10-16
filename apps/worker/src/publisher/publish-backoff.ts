// The backoff of the publish job (guide step 4.8, architecture 7.1): 30 s, 2 min, 8 min, 30 min
// and 2 h, each with a jitter of 20 percent, for at most six attempts. A wait the platform asked
// for wins when it is longer. The publisher registers it as settings.backoffStrategy; the jobs
// name it in their options (PUBLISH_BACKOFF of @smp/queue).

export const PUBLISH_BACKOFF_DELAYS_MS = [30_000, 120_000, 480_000, 1_800_000, 7_200_000] as const;
const JITTER = 0.2;

/** Asks the queue for another attempt, at the earliest after retryAfterMs. */
export class PublishRetryError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`The publish failed for now: ${code}.`);
    this.name = 'PublishRetryError';
  }
}

/**
 * The strategy with its source of randomness; tests pass a fixed one. attemptsMade counts the
 * failed attempts, the first is 1.
 */
export const publishBackoffWith =
  (random: () => number) =>
  (attemptsMade: number, _type?: string, error?: Error): number => {
    const step = Math.min(Math.max(attemptsMade, 1), PUBLISH_BACKOFF_DELAYS_MS.length) - 1;
    const base = PUBLISH_BACKOFF_DELAYS_MS[step] ?? PUBLISH_BACKOFF_DELAYS_MS[0];
    const jittered = Math.round(base * (1 - JITTER + random() * 2 * JITTER));
    const asked = error instanceof PublishRetryError ? (error.retryAfterMs ?? 0) : 0;
    return Math.max(jittered, asked);
  };

/** settings.backoffStrategy of the publisher. */
export const publishBackoff = publishBackoffWith(Math.random);
