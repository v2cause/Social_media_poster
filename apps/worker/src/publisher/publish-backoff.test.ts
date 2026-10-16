import { describe, expect, it } from 'vitest';

import { PUBLISH_BACKOFF_DELAYS_MS, publishBackoffWith, PublishRetryError } from './publish-backoff';

// Architecture 7.1: 30 s, 2 min, 8 min, 30 min, 2 h with jitter; a longer wait of the platform wins.

const middle = publishBackoffWith(() => 0.5);

describe('the backoff of the publish job', () => {
  it('waits 30 s, 2 min, 8 min, 30 min and 2 h in the middle of its jitter', () => {
    expect([1, 2, 3, 4, 5].map((attempts) => middle(attempts, 'publish'))).toEqual([
      ...PUBLISH_BACKOFF_DELAYS_MS,
    ]);
    expect(middle(9, 'publish')).toBe(7_200_000);
  });

  it('spreads each wait by 20 percent', () => {
    expect(publishBackoffWith(() => 0)(1, 'publish')).toBe(24_000);
    expect(publishBackoffWith(() => 0.999_999)(1, 'publish')).toBe(36_000);
  });

  it('waits at least as long as the platform asked', () => {
    const asked = new PublishRetryError('TRANSIENT', 90_000);
    expect(middle(1, 'publish', asked)).toBe(90_000);
    expect(middle(4, 'publish', asked)).toBe(1_800_000);
    expect(middle(1, 'publish', new PublishRetryError('TRANSIENT', null))).toBe(30_000);
  });
});
