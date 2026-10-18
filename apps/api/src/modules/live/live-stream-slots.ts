import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';

import { REDIS_CLIENT } from '../../infrastructure/clients.module';

// The open live streams of a user across all API processes (guide step 8.4, ASVS 15.2.2). Every
// stream holds a slot in a sorted set of the user, scored with the end of its lease; the heartbeat
// of the stream renews it. A process that dies frees its slots once their leases run out, so no
// slot stays taken for good.

export interface LiveStreamLimits {
  /** Open streams per user: a browser opens one per tab. */
  perUser: number;
  /** How long a slot lasts without a renewal; a few heartbeats. */
  leaseMs: number;
}

export const LIVE_STREAM_LIMITS = Symbol('LIVE_STREAM_LIMITS');

export const DEFAULT_LIVE_STREAM_LIMITS: LiveStreamLimits = { perUser: 10, leaseMs: 45_000 };

// Drops the slots whose lease ran out, then takes one if there is room. Returns 1 or 0.
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return 1`;

const RENEW = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
return 1`;

export interface LiveStreamSlot {
  /** Extends the lease; called with every heartbeat. Never throws. */
  renew(): Promise<void>;
  /** Frees the slot when the stream closes. Never throws. */
  release(): Promise<void>;
}

@Injectable()
export class LiveStreamSlots {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(LIVE_STREAM_LIMITS) private readonly limits: LiveStreamLimits,
  ) {}

  /** A slot for a new stream of the user, or null when all of them are taken. */
  async acquire(userId: string): Promise<LiveStreamSlot | null> {
    const key = `live:streams:${userId}`;
    const member = uuidv7();
    const now = Date.now();
    const taken = Number(
      await this.redis.eval(
        ACQUIRE,
        1,
        key,
        String(now),
        String(now + this.limits.leaseMs),
        String(this.limits.perUser),
        member,
      ),
    );
    if (taken === 0) {
      return null;
    }
    let released = false;
    return {
      renew: async () => {
        if (!released) {
          await this.redis
            .eval(RENEW, 1, key, String(Date.now() + this.limits.leaseMs), member)
            .catch(() => undefined);
        }
      },
      release: async () => {
        if (!released) {
          released = true;
          await this.redis.zrem(key, member).catch(() => undefined);
        }
      },
    };
  }
}
