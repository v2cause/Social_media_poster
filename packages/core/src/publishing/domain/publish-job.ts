import type { PlatformError, PlatformErrorCode } from '../../channels/domain/platform-error';
import type { VariantStatus } from '../../content/domain/types';
import type { MissedWindowBehavior } from '../../tenancy/domain/types';
import { MISSED_WINDOW_MS } from './rules';

// Rules of the publish job (guide step 4.8, architecture 7 and 7.1): which variants a job runs,
// how long its lease lasts, and how it reacts to the errors of the platforms.

/** Why a variant did not go out, as the UI translates it (step 4.11). */
export const PUBLISH_FAILURE_CODES = [
  // Errors of the platforms (architecture 4.1) that end a run.
  'PERMISSION_DENIED',
  'VALIDATION_REJECTED',
  'DUPLICATE',
  'TRANSIENT',
  'MEDIA_PROCESSING',
  'RATE_LIMITED',
  'OUTCOME_UNKNOWN',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  // Decided by the job.
  'REAUTH_REQUIRED',
  'SPEND_CAP',
  'MISSED_WINDOW',
  'SOCIAL_ACCOUNT_DISCONNECTED',
  'ADAPTER_UNAVAILABLE',
  'VARIANT_NOT_PUBLISHABLE',
  'INTERNAL',
] as const;
export type PublishFailureCode = (typeof PUBLISH_FAILURE_CODES)[number];

/** A lease lasts five minutes (architecture 7) and is extended before long steps. */
export const PUBLISH_LEASE_MS = 5 * 60 * 1000;
/** A job that meets the live lease of another run waits this much longer than the lease. */
export const LEASE_GRACE_MS = 1000;
/** The reconcile looks this much further back, for clocks that differ between us and the platform. */
export const RECONCILE_SKEW_MS = 60 * 1000;
/** The wait after a rate limit without Retry-After. */
export const RATE_LIMIT_FALLBACK_MS = 60 * 1000;

const RUNNABLE: readonly VariantStatus[] = ['QUEUED', 'RETRYING', 'PUBLISHING'];

/** The statuses a job of the current schedule version takes over. */
export const isRunnable = (status: VariantStatus): boolean => RUNNABLE.includes(status);

/**
 * A queued variant whose job comes more than 6 h after its time (the queue was down, or the
 * sweeper found the job lost) fails instead of going out late, unless the workspace says
 * otherwise. Only for the automatic triggers: "Jetzt posten" and "erneut" are the user's choice.
 */
export function isMissedWindow(
  variant: {
    status: VariantStatus;
    scheduledAt: Date | null;
    queuedAt: Date | null;
    missedWindowBehavior: MissedWindowBehavior;
  },
  trigger: string,
  now: Date,
): boolean {
  const due = variant.scheduledAt ?? variant.queuedAt;
  return (
    (trigger === 'schedule' || trigger === 'sweep') &&
    variant.status === 'QUEUED' &&
    variant.missedWindowBehavior === 'FAIL' &&
    due !== null &&
    now.getTime() - due.getTime() > MISSED_WINDOW_MS
  );
}

/** How a run reacts to an error of the platform (architecture 7.1). */
export type PlatformErrorReaction =
  | { kind: 'retry'; code: PublishFailureCode; retryAfterMs: number | null; countsAsAttempt: boolean }
  | { kind: 'failed'; code: PublishFailureCode }
  | { kind: 'needs_attention'; code: PublishFailureCode; reauth: boolean }
  /** The token was refused after the one refresh: the connection needs a new grant. */
  | { kind: 'reauth' }
  /** The request went out and the answer is missing: look for the post first. */
  | { kind: 'reconcile' };

/** The codes without a reaction of their own end the run, or retry it when they pass. */
const FAILURE_OF: Record<
  Exclude<
    PlatformErrorCode,
    'RATE_LIMITED' | 'AUTH_EXPIRED' | 'OUTCOME_UNKNOWN' | 'CHALLENGE_REQUIRED' | 'SELECTOR_DRIFT'
  >,
  PublishFailureCode
> = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  VALIDATION_REJECTED: 'VALIDATION_REJECTED',
  DUPLICATE: 'DUPLICATE',
  MEDIA_PROCESSING: 'MEDIA_PROCESSING',
  TRANSIENT: 'TRANSIENT',
  SPEND_CAP_REACHED: 'SPEND_CAP',
};

/**
 * The reaction to an error of the platform. sent tells whether the failed call was the publish
 * itself; an unknown outcome of a read (reconcile, refresh) is a transient error.
 */
export function reactionTo(
  error: PlatformError,
  context: { sent: boolean; lastAttempt: boolean },
): PlatformErrorReaction {
  switch (error.code) {
    case 'RATE_LIMITED':
      // Waiting does not use up an attempt; the job moves to later.
      return {
        kind: 'retry',
        code: 'RATE_LIMITED',
        retryAfterMs: error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS,
        countsAsAttempt: false,
      };
    case 'AUTH_EXPIRED':
      return { kind: 'reauth' };
    case 'OUTCOME_UNKNOWN':
      return context.sent ? { kind: 'reconcile' } : retryOrFail('TRANSIENT', error, context.lastAttempt);
    case 'CHALLENGE_REQUIRED':
      return { kind: 'needs_attention', code: 'CHALLENGE_REQUIRED', reauth: true };
    case 'SELECTOR_DRIFT':
      return { kind: 'needs_attention', code: 'SELECTOR_DRIFT', reauth: false };
    default: {
      const code = FAILURE_OF[error.code];
      return error.retryable ? retryOrFail(code, error, context.lastAttempt) : { kind: 'failed', code };
    }
  }
}

function retryOrFail(
  code: PublishFailureCode,
  error: PlatformError,
  lastAttempt: boolean,
): PlatformErrorReaction {
  return lastAttempt
    ? { kind: 'failed', code }
    : { kind: 'retry', code, retryAfterMs: error.retryAfterMs ?? null, countsAsAttempt: true };
}
