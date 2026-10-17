import { randomUUID } from 'node:crypto';

import { BREAKER_WINDOW_MS, type SelectorDriftCounter } from '@smp/core';
import type Redis from 'ioredis';

// The drifts of the selector map for the circuit breaker (guide step 6.5): a sorted set by time,
// shared by every worker that reads the reports, outside the keys of the browser worker. One
// script adds the drift, drops those older than the window and counts the rest, so two drifts at
// the same time get two counts.

const KEY = 'x-browser:breaker:drifts';

// ARGV: the time of the drift, its member, the start of the window, the length of the window.
const RECORD = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return redis.call('ZCARD', KEYS[1])`;

export class RedisSelectorDriftCounter implements SelectorDriftCounter {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs = BREAKER_WINDOW_MS,
  ) {}

  async record(at: Date): Promise<number> {
    const time = at.getTime();
    return Number(
      await this.redis.eval(
        RECORD,
        1,
        KEY,
        String(time),
        `${String(time)}:${randomUUID()}`,
        String(time - this.windowMs),
        String(this.windowMs),
      ),
    );
  }

  async reset(): Promise<void> {
    await this.redis.del(KEY);
  }
}
