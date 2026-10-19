import { describe, expect, it } from 'vitest';

import { HealthController } from './health.controller';

// Guide step 8.7: the liveness check needs no dependency, not even Redis for the rate limits; the
// readiness check keeps its limits and so its dependency on Redis.

const handlerOf = (name: 'live' | 'ready'): object =>
  Object.getOwnPropertyDescriptor(HealthController.prototype, name)?.value as object;

const skips = (handler: object, name: string): unknown =>
  Reflect.getMetadata(`THROTTLER:SKIP${name}`, handler) ??
  Reflect.getMetadata(`THROTTLER:SKIP${name}`, HealthController);

describe('the health checks', () => {
  it('skip every rate limit for liveness and only the one per user for readiness', () => {
    const live = handlerOf('live');
    const ready = handlerOf('ready');

    expect(skips(live, 'address')).toBe(true);
    expect(skips(live, 'user')).toBe(true);
    expect(skips(ready, 'address')).toBeUndefined();
    expect(skips(ready, 'user')).toBe(true);
  });
});
