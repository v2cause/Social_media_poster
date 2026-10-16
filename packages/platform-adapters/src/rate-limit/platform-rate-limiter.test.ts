import { describe, expect, it } from 'vitest';

import { DEFAULT_RATE_LIMITS, PlatformRateLimiter } from './platform-rate-limiter';

// Own limits per app and account (architecture 10).

const limits = {
  ...DEFAULT_RATE_LIMITS,
  X: { app: { points: 3, durationSeconds: 60 }, account: { points: 2, durationSeconds: 60 } },
};

describe('PlatformRateLimiter', () => {
  it('limits each account and the app as a whole', async () => {
    const limiter = PlatformRateLimiter.memory(limits);

    await limiter.acquire({ platform: 'X', accountId: 'a' });
    await limiter.acquire({ platform: 'X', accountId: 'a' });
    await expect(limiter.acquire({ platform: 'X', accountId: 'a' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    // b has its own account bucket, but the app bucket has one point left.
    await limiter.acquire({ platform: 'X', accountId: 'b' });
    await expect(limiter.acquire({ platform: 'X', accountId: 'c' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    // Other platforms are not affected.
    await expect(limiter.acquire({ platform: 'LINKEDIN', accountId: 'a' })).resolves.toBeUndefined();
  });

  it('blocks an account for the wait the platform asked for', async () => {
    const limiter = PlatformRateLimiter.memory();

    await limiter.penalize({ platform: 'FACEBOOK', accountId: 'page-1' }, 45_000);

    const error = (await limiter
      .acquire({ platform: 'FACEBOOK', accountId: 'page-1' })
      .catch((failed: unknown) => failed)) as {
      code: string;
      retryAfterMs: number;
    };
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBeGreaterThan(40_000);
    await expect(limiter.acquire({ platform: 'FACEBOOK', accountId: 'page-2' })).resolves.toBeUndefined();
  });
});
