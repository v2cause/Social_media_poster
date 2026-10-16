import { PlatformError } from '@smp/core';
import type { Platform } from '@smp/platform-rules';
import type Redis from 'ioredis';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';

// Outgoing rate limits per platform, app and account (architecture 10): rate-limiter-flexible
// with Redis, so all workers share the buckets. The limits are self-imposed and stay below the
// documented ones; the adapter phases check them against the documentation. A 429 of the
// platform blocks the bucket for the wait it asked for ("der Plattform-Limiter wird gefüttert").

export interface RateLimitScope {
  platform: Platform;
  /** The app, where a platform has several (LinkedIn: sign-in and community management). */
  app?: string;
  /** The SocialAccount the call is for. */
  accountId?: string;
}

export interface BucketLimit {
  points: number;
  durationSeconds: number;
}

export interface PlatformRateLimits {
  app: BucketLimit;
  account: BucketLimit;
}

export const DEFAULT_RATE_LIMITS: Readonly<Record<Platform, PlatformRateLimits>> = {
  LINKEDIN: { app: { points: 600, durationSeconds: 60 }, account: { points: 30, durationSeconds: 60 } },
  FACEBOOK: { app: { points: 600, durationSeconds: 60 }, account: { points: 30, durationSeconds: 60 } },
  INSTAGRAM: { app: { points: 600, durationSeconds: 60 }, account: { points: 30, durationSeconds: 60 } },
  X: { app: { points: 300, durationSeconds: 60 }, account: { points: 15, durationSeconds: 60 } },
};

type Level = 'app' | 'account';

export class PlatformRateLimiter {
  private constructor(
    private readonly create: (level: Level, platform: Platform, limit: BucketLimit) => RateLimiterAbstract,
    private readonly limits: Readonly<Record<Platform, PlatformRateLimits>>,
  ) {}

  private readonly buckets = new Map<string, RateLimiterAbstract>();

  /** Buckets in Redis, shared by all workers. */
  static redis(client: Redis, limits = DEFAULT_RATE_LIMITS): PlatformRateLimiter {
    return new PlatformRateLimiter(
      (level, platform, limit) =>
        new RateLimiterRedis({
          storeClient: client,
          keyPrefix: `rl:${platform}:${level}`,
          points: limit.points,
          duration: limit.durationSeconds,
        }),
      limits,
    );
  }

  /** Buckets in the process, for tests and the mock adapter. */
  static memory(limits = DEFAULT_RATE_LIMITS): PlatformRateLimiter {
    return new PlatformRateLimiter(
      (level, platform, limit) =>
        new RateLimiterMemory({
          keyPrefix: `rl:${platform}:${level}`,
          points: limit.points,
          duration: limit.durationSeconds,
        }),
      limits,
    );
  }

  /** Takes a point from the app and the account bucket; throws RATE_LIMITED when one is empty. */
  async acquire(scope: RateLimitScope): Promise<void> {
    for (const [bucket, key] of this.keysOf(scope)) {
      try {
        await bucket.consume(key, 1);
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          throw new PlatformError('RATE_LIMITED', `Own rate limit of ${scope.platform} reached`, {
            retryAfterMs: Math.max(1, Math.round(error.msBeforeNext)),
          });
        }
        throw new PlatformError('TRANSIENT', 'The rate limiter is not available');
      }
    }
  }

  /** Blocks the account bucket, or the app bucket for app-wide limits, for the wait. */
  async penalize(
    scope: RateLimitScope,
    retryAfterMs: number,
    level: Level = scope.accountId ? 'account' : 'app',
  ): Promise<void> {
    const seconds = Math.ceil(retryAfterMs / 1000);
    if (seconds <= 0) {
      return;
    }
    const entry = this.keysOf(scope).find(([, , entryLevel]) => entryLevel === level);
    if (entry) {
      await entry[0].block(entry[1], seconds);
    }
  }

  private keysOf(scope: RateLimitScope): [RateLimiterAbstract, string, Level][] {
    // The account first: a call its own account refuses must not use up the app bucket.
    const keys: [RateLimiterAbstract, string, Level][] = [];
    if (scope.accountId) {
      keys.push([this.bucket('account', scope.platform), scope.accountId, 'account']);
    }
    keys.push([this.bucket('app', scope.platform), scope.app ?? 'default', 'app']);
    return keys;
  }

  private bucket(level: Level, platform: Platform): RateLimiterAbstract {
    const name = `${level}:${platform}`;
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = this.create(level, platform, this.limits[platform][level]);
      this.buckets.set(name, bucket);
    }
    return bucket;
  }
}
