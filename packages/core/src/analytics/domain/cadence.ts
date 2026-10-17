import type { Platform } from '@smp/platform-rules';

import type { ConnectionMethod } from '../../channels/domain/types';

// The polling cascade of a post (architecture 8): the hours after its publication at which its
// metrics are read, batched per account. Reads cost money on X, so the polls of its API start
// after a day and end after a week; the browser of X (phase 6) reads twice. The poll after 30
// days on X depends on the plan and comes with billing (phase 7). The mock adapter polls like the
// API of its platform.

const HOUR_MS = 60 * 60 * 1000;
const STANDARD_HOURS: readonly number[] = [1, 24, 72, 168, 720];
const X_API_HOURS: readonly number[] = [24, 72, 168];
const X_BROWSER_HOURS: readonly number[] = [24, 168];

/** The polls of a post, in hours after its publication. */
export function cadenceHours(platform: Platform, method: ConnectionMethod): readonly number[] {
  if (platform !== 'X') {
    return STANDARD_HOURS;
  }
  return method === 'BROWSER' ? X_BROWSER_HOURS : X_API_HOURS;
}

/**
 * When poll `step` (from 0) of a post is due, or null after the last one. A scale above 1 speeds
 * the cascade up for tests: with ANALYTICS_CADENCE_SCALE=60 an hour lasts a minute.
 */
export function metricsDueAt(
  platform: Platform,
  method: ConnectionMethod,
  publishedAt: Date,
  step: number,
  scale = 1,
): Date | null {
  const hours = cadenceHours(platform, method)[step];
  return hours === undefined ? null : new Date(publishedAt.getTime() + (hours * HOUR_MS) / scale);
}

/**
 * Posts per metrics call (architecture 8): X reads up to 100 ids at once, Meta batches up to 50.
 * LinkedIn reads lists of shares; 50 until its adapter (guide step 4.12) says otherwise.
 */
export const METRICS_BATCH_SIZE: Readonly<Record<Platform, number>> = {
  X: 100,
  FACEBOOK: 50,
  INSTAGRAM: 50,
  LINKEDIN: 50,
};

/** The poll after a poll of step `step` at `polledAt`; polls whose time has passed are skipped. */
export function nextPollAfter(
  platform: Platform,
  method: ConnectionMethod,
  publishedAt: Date,
  step: number,
  polledAt: Date,
  scale = 1,
): { step: number; at: Date } | null {
  for (let next = step + 1; ; next += 1) {
    const at = metricsDueAt(platform, method, publishedAt, next, scale);
    if (at === null) {
      return null;
    }
    if (at.getTime() > polledAt.getTime()) {
      return { step: next, at };
    }
  }
}
