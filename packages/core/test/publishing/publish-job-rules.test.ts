import { describe, expect, it } from 'vitest';

import {
  firstMetricsAt,
  isMissedWindow,
  isRunnable,
  PLATFORM_ERROR_CODES,
  PlatformError,
  PUBLISH_FAILURE_CODES,
  RATE_LIMIT_FALLBACK_MS,
  reactionTo,
  VARIANT_STATUSES,
  type PlatformErrorCode,
  type PlatformErrorReaction,
} from '../../src';

// Guide step 4.8: the error table of architecture 7.1 as a pure function, and which variants a
// job takes over.

const error = (code: PlatformErrorCode, retryAfterMs?: number) =>
  new PlatformError(code, `${code} happened`, retryAfterMs === undefined ? {} : { retryAfterMs });

describe('the reaction to errors of the platforms', () => {
  const table: [PlatformErrorCode, PlatformErrorReaction][] = [
    [
      'RATE_LIMITED',
      { kind: 'retry', code: 'RATE_LIMITED', retryAfterMs: RATE_LIMIT_FALLBACK_MS, countsAsAttempt: false },
    ],
    ['TRANSIENT', { kind: 'retry', code: 'TRANSIENT', retryAfterMs: null, countsAsAttempt: true }],
    [
      'MEDIA_PROCESSING',
      { kind: 'retry', code: 'MEDIA_PROCESSING', retryAfterMs: null, countsAsAttempt: true },
    ],
    ['AUTH_EXPIRED', { kind: 'reauth' }],
    ['VALIDATION_REJECTED', { kind: 'failed', code: 'VALIDATION_REJECTED' }],
    ['PERMISSION_DENIED', { kind: 'failed', code: 'PERMISSION_DENIED' }],
    ['DUPLICATE', { kind: 'failed', code: 'DUPLICATE' }],
    ['OUTCOME_UNKNOWN', { kind: 'reconcile' }],
    ['CHALLENGE_REQUIRED', { kind: 'needs_attention', code: 'CHALLENGE_REQUIRED', reauth: true }],
    ['SELECTOR_DRIFT', { kind: 'needs_attention', code: 'SELECTOR_DRIFT', reauth: false }],
    ['SPEND_CAP_REACHED', { kind: 'failed', code: 'SPEND_CAP' }],
  ];

  it('covers every code of the taxonomy', () => {
    expect(table.map(([code]) => code).sort()).toEqual([...PLATFORM_ERROR_CODES].sort());
  });

  it.each(table)('reacts to %s after the publish call as in architecture 7.1', (code, reaction) => {
    expect(reactionTo(error(code), { sent: true, lastAttempt: false })).toEqual(reaction);
  });

  it('fails instead of retrying on the last attempt, except for a rate limit', () => {
    expect(reactionTo(error('TRANSIENT'), { sent: true, lastAttempt: true })).toEqual({
      kind: 'failed',
      code: 'TRANSIENT',
    });
    expect(reactionTo(error('RATE_LIMITED', 5_000), { sent: true, lastAttempt: true })).toEqual({
      kind: 'retry',
      code: 'RATE_LIMITED',
      retryAfterMs: 5_000,
      countsAsAttempt: false,
    });
  });

  it('keeps the wait the platform asks for', () => {
    expect(reactionTo(error('TRANSIENT', 30_000), { sent: false, lastAttempt: false })).toMatchObject({
      kind: 'retry',
      retryAfterMs: 30_000,
    });
  });

  it('treats a lost answer of a read as a transient error', () => {
    expect(reactionTo(error('OUTCOME_UNKNOWN'), { sent: false, lastAttempt: false })).toEqual({
      kind: 'retry',
      code: 'TRANSIENT',
      retryAfterMs: null,
      countsAsAttempt: true,
    });
  });

  it('follows the retryable flag of the error', () => {
    const final = new PlatformError('TRANSIENT', 'gone for good', { retryable: false });
    expect(reactionTo(final, { sent: true, lastAttempt: false })).toEqual({
      kind: 'failed',
      code: 'TRANSIENT',
    });
  });

  it('only yields failure codes the UI knows', () => {
    for (const code of PLATFORM_ERROR_CODES) {
      const reaction = reactionTo(error(code), { sent: true, lastAttempt: false });
      if ('code' in reaction) {
        expect(PUBLISH_FAILURE_CODES).toContain(reaction.code);
      }
    }
  });
});

describe('the variants a publish job runs', () => {
  it('takes over queued, retrying and publishing variants only', () => {
    expect(VARIANT_STATUSES.filter(isRunnable)).toEqual(['QUEUED', 'PUBLISHING', 'RETRYING']);
  });

  const now = new Date('2026-10-16T12:00:00Z');
  const queued = {
    status: 'QUEUED' as const,
    scheduledAt: new Date('2026-10-16T05:59:00Z'),
    queuedAt: new Date('2026-10-16T05:58:30Z'),
    missedWindowBehavior: 'FAIL' as const,
  };

  it('misses the window more than 6 h after the planned time, for the automatic triggers', () => {
    expect(isMissedWindow(queued, 'schedule', now)).toBe(true);
    expect(isMissedWindow(queued, 'sweep', now)).toBe(true);
    expect(isMissedWindow(queued, 'now', now)).toBe(false);
    expect(isMissedWindow(queued, 'retry', now)).toBe(false);
    expect(isMissedWindow({ ...queued, scheduledAt: new Date('2026-10-16T06:01:00Z') }, 'sweep', now)).toBe(
      false,
    );
    expect(isMissedWindow({ ...queued, missedWindowBehavior: 'POST_ANYWAY' }, 'sweep', now)).toBe(false);
    expect(isMissedWindow({ ...queued, status: 'PUBLISHING' }, 'sweep', now)).toBe(false);
  });

  it('measures "Jetzt posten" from the time it was queued', () => {
    expect(isMissedWindow({ ...queued, scheduledAt: null }, 'sweep', now)).toBe(true);
  });

  it('polls the first metrics after an hour, on X after a day', () => {
    expect(firstMetricsAt('LINKEDIN', now)).toEqual(new Date('2026-10-16T13:00:00Z'));
    expect(firstMetricsAt('X', now)).toEqual(new Date('2026-10-17T12:00:00Z'));
  });
});
