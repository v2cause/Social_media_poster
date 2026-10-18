import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

// The counters of @nestjs/throttler in Redis (architecture 10, guide step 8.4), so that every
// instance of the API counts the same requests. A window is fixed: it starts with the first
// request of its key, and once the limit is passed the key stays blocked until the window ends.
// The block durations of the throttlers are therefore not used.

// INCR with the expiry set on the first hit; returns the hits and the time left in the window.
const HIT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {hits, redis.call('PTTL', KEYS[1])}`;

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const reply = (await this.redis.eval(
      HIT,
      1,
      `throttle:${throttlerName}:${key}`,
      String(ttl),
    )) as unknown[];
    const hits = Number(reply[0]);
    const secondsLeft = Math.max(0, Math.ceil(Number(reply[1]) / 1000));
    const isBlocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire: secondsLeft,
      isBlocked,
      timeToBlockExpire: isBlocked ? secondsLeft : 0,
    };
  }
}
