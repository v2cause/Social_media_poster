import { startRedis, type StartedRedis } from '@smp/testing';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisSelectorDriftCounter } from '../src';

// Guide step 6.5 on Redis: the drifts of the last hour count across every worker, drifts at the
// same time get counts of their own, older ones drop out, and the breaker starts the count anew.

describe('RedisSelectorDriftCounter', () => {
  let started: StartedRedis | undefined;
  let redis: Redis | undefined;

  beforeAll(async () => {
    started = await startRedis();
    redis = new Redis(started.url);
  });

  afterAll(async () => {
    redis?.disconnect();
    await started?.stop();
  });

  it('counts the drifts of the last hour, two at once apart, and starts anew after a reset', async () => {
    const counter = new RedisSelectorDriftCounter(redis as Redis);
    const at = (iso: string) => new Date(iso);

    await expect(counter.record(at('2026-10-17T08:00:00Z'))).resolves.toBe(1);
    const both = await Promise.all([
      counter.record(at('2026-10-17T08:30:00Z')),
      counter.record(at('2026-10-17T08:30:00Z')),
    ]);
    expect(both.sort()).toEqual([2, 3]);
    // The first one is an hour old now.
    await expect(counter.record(at('2026-10-17T09:00:00Z'))).resolves.toBe(3);
    expect(await (redis as Redis).pttl('x-browser:breaker:drifts')).toBeGreaterThan(59 * 60_000);

    await counter.reset();
    await expect(counter.record(at('2026-10-17T09:01:00Z'))).resolves.toBe(1);
  });
});
