import type { PlatformError } from '../../channels/domain/platform-error';
import type { PublishResult } from '../../channels/ports/platform-adapter';
import type { PlatformErrorReaction, PublishFailureCode } from '../domain/publish-job';
import type { PublishAttemptResult, VariantRunResult } from '../ports/publish-job';
import type { PublishJobOutcome } from './publish-job-types';

// How a run of the publish job ends (guide step 4.8, architecture 7.1), and what that end writes
// to the variant and to its attempt. Pure functions, so the table stays readable.

/** Marks the connection NEEDS_REAUTH with this reason when the run ends. */
export interface Reauth {
  connectionId: string;
  reason: string;
}

export type RunEnd =
  | { kind: 'published'; result: PublishResult; reconciled: boolean; contentHash: string }
  | { kind: 'dry_run'; contentHash: string; payload: Record<string, unknown> }
  | {
      kind: 'retry';
      code: PublishFailureCode;
      retryAfterMs: number | null;
      countsAsAttempt: boolean;
      errorCode: string;
      message: string | null;
      /** The request went out and the answer is missing: the attempt stays UNKNOWN. */
      unknown: boolean;
    }
  | { kind: 'failed'; code: PublishFailureCode; errorCode: string; message: string | null; reauth?: Reauth }
  | {
      kind: 'needs_attention';
      code: PublishFailureCode;
      errorCode: string;
      message: string | null;
      unknown: boolean;
      reauth?: Reauth;
    }
  /** Another run took the variant over: only the attempt is closed. */
  | { kind: 'lease_lost'; unknown: boolean };

export const failedEnd = (code: PublishFailureCode, message: string): RunEnd => ({
  kind: 'failed',
  code,
  errorCode: code,
  message,
});

/** Tries again with the backoff of the queue, or fails when no attempt is left. */
export const retryOrFailEnd = (code: PublishFailureCode, message: string, lastAttempt: boolean): RunEnd =>
  lastAttempt
    ? failedEnd(code, message)
    : {
        kind: 'retry',
        code,
        retryAfterMs: null,
        countsAsAttempt: true,
        errorCode: code,
        message,
        unknown: false,
      };

/**
 * The post may be out: the attempt stays UNKNOWN. Another run reconciles before anything else;
 * without an attempt left, the user decides.
 */
export const unknownEnd = (errorCode: string, message: string, lastAttempt: boolean): RunEnd =>
  lastAttempt
    ? { kind: 'needs_attention', code: 'OUTCOME_UNKNOWN', errorCode, message, unknown: true }
    : {
        kind: 'retry',
        code: 'OUTCOME_UNKNOWN',
        retryAfterMs: null,
        countsAsAttempt: true,
        errorCode,
        message,
        unknown: true,
      };

/** Architecture 7.1: the token was refused after the one refresh, or the refresh failed. */
export const reauthEnd = (reason: string, connectionId: string | null): RunEnd => ({
  kind: 'failed',
  code: 'REAUTH_REQUIRED',
  errorCode: 'AUTH_EXPIRED',
  message: `The platform refused the token: ${reason}.`,
  ...(connectionId === null ? {} : { reauth: { connectionId, reason } }),
});

/** The end of a reaction to an error of the platform. */
export function endOfReaction(
  reaction: PlatformErrorReaction,
  error: PlatformError,
  connectionId: string | null,
): RunEnd {
  switch (reaction.kind) {
    case 'retry':
      return { ...reaction, errorCode: error.code, message: error.message, unknown: false };
    case 'failed':
      return { kind: 'failed', code: reaction.code, errorCode: error.code, message: error.message };
    case 'needs_attention':
      return {
        kind: 'needs_attention',
        code: reaction.code,
        errorCode: error.code,
        message: error.message,
        unknown: false,
        ...(reaction.reauth && connectionId !== null ? { reauth: { connectionId, reason: error.code } } : {}),
      };
    case 'reauth':
      return reauthEnd('REFRESH_FAILED', connectionId);
    case 'reconcile':
      return {
        kind: 'needs_attention',
        code: 'OUTCOME_UNKNOWN',
        errorCode: error.code,
        message: error.message,
        unknown: true,
      };
  }
}

/** The variant after the run; `firstPoll` names the first metrics poll of a published post. */
export function variantResultOf(
  end: Exclude<RunEnd, { kind: 'lease_lost' }>,
  firstPoll: (publishedAt: Date) => Date | null,
  now: Date,
): VariantRunResult {
  switch (end.kind) {
    case 'published':
      return {
        status: 'PUBLISHED',
        publishedAt: end.result.publishedAt,
        externalPostId: end.result.externalPostId,
        externalUrl: end.result.externalUrl,
        contentHash: end.contentHash,
        isDryRun: false,
        metricsNextAt: firstPoll(end.result.publishedAt),
      };
    case 'dry_run':
      return {
        status: 'PUBLISHED',
        publishedAt: now,
        externalPostId: null,
        externalUrl: null,
        contentHash: end.contentHash,
        isDryRun: true,
        metricsNextAt: null,
      };
    case 'retry':
      return { status: 'RETRYING', failureCode: end.code, lastError: end.message };
    case 'failed':
      return { status: 'FAILED', failureCode: end.code, lastError: end.message };
    case 'needs_attention':
      return { status: 'NEEDS_ATTENTION', failureCode: end.code, lastError: end.message };
  }
}

export function attemptResultOf(end: RunEnd, finishedAt: Date): PublishAttemptResult {
  const base = { errorCode: null, errorMessage: null, externalPostId: null, meta: {}, finishedAt };
  switch (end.kind) {
    case 'published':
      return {
        ...base,
        outcome: end.reconciled ? 'RECONCILED' : 'PUBLISHED',
        externalPostId: end.result.externalPostId,
        meta: end.result.meta ?? {},
      };
    case 'dry_run':
      return { ...base, outcome: 'DRY_RUN', meta: { payload: end.payload } };
    case 'retry':
      return {
        ...base,
        outcome: end.unknown ? 'UNKNOWN' : 'RETRY',
        errorCode: end.errorCode,
        errorMessage: end.message,
      };
    case 'failed':
      return { ...base, outcome: 'FAILED', errorCode: end.errorCode, errorMessage: end.message };
    case 'needs_attention':
      return {
        ...base,
        outcome: end.unknown ? 'UNKNOWN' : 'FAILED',
        errorCode: end.errorCode,
        errorMessage: end.message,
      };
    case 'lease_lost':
      return {
        ...base,
        outcome: end.unknown ? 'UNKNOWN' : 'FAILED',
        errorCode: 'LEASE_LOST',
        errorMessage: 'Another run took the variant over.',
      };
  }
}

export function outcomeOf(end: RunEnd): PublishJobOutcome {
  switch (end.kind) {
    case 'published':
      return { kind: 'published', reconciled: end.reconciled, dryRun: false };
    case 'dry_run':
      return { kind: 'published', reconciled: false, dryRun: true };
    case 'retry':
      return {
        kind: 'retry',
        code: end.code,
        retryAfterMs: end.retryAfterMs,
        countsAsAttempt: end.countsAsAttempt,
      };
    case 'failed':
      return { kind: 'failed', code: end.code };
    case 'needs_attention':
      return { kind: 'needs_attention', code: end.code };
    case 'lease_lost':
      return { kind: 'skipped', reason: 'LEASE_LOST' };
  }
}
