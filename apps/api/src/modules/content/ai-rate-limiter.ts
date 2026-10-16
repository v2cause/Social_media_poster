import { Inject, Injectable } from '@nestjs/common';
import { AiRateLimitedError, type ContentActor } from '@smp/core';
import type Redis from 'ioredis';

import { REDIS_CLIENT } from '../../infrastructure/clients.module';

// Guard rails of the AI routes (architecture 5.3): per user 10 calls a minute and 2 at once, per
// workspace 60 calls an hour. Fixed windows in Redis; the quota caps the cost on top of this.

export interface AiRateLimits {
  perUserPerMinute: number;
  concurrentPerUser: number;
  perWorkspacePerHour: number;
}

export const AI_RATE_LIMITS = Symbol('AI_RATE_LIMITS');

export const DEFAULT_AI_RATE_LIMITS: AiRateLimits = {
  perUserPerMinute: 10,
  concurrentPerUser: 2,
  perWorkspacePerHour: 60,
};

// INCR with an expiry set on the first hit: one round trip, no key without expiry.
const INCREMENT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

// A running call holds a slot; the expiry frees slots of a process that died mid-call.
const ACQUIRE = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return count`;

const RELEASE = `
local count = redis.call('DECR', KEYS[1])
if count <= 0 then redis.call('DEL', KEYS[1]) end
return count`;

/** The longest an AI call may hold a slot. */
const SLOT_TTL_SECONDS = 600;

export interface AiSlot {
  release(): Promise<void>;
}

@Injectable()
export class AiRateLimiter {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AI_RATE_LIMITS) private readonly limits: AiRateLimits,
  ) {}

  /** Counts the call against the windows and takes a slot; throws AiRateLimitedError. */
  async acquire(actor: ContentActor, now = Date.now()): Promise<AiSlot> {
    const minute = Math.floor(now / 60_000);
    const hour = Math.floor(now / 3_600_000);
    const [perMinute, perHour] = await Promise.all([
      this.increment(`ai:rate:user:${actor.userId}:${String(minute)}`, 60),
      this.increment(`ai:rate:workspace:${actor.workspaceId}:${String(hour)}`, 3600),
    ]);
    if (perMinute > this.limits.perUserPerMinute || perHour > this.limits.perWorkspacePerHour) {
      throw new AiRateLimitedError();
    }
    const slots = `ai:slots:user:${actor.userId}`;
    const taken = Number(
      await this.redis.eval(
        ACQUIRE,
        1,
        slots,
        String(this.limits.concurrentPerUser),
        String(SLOT_TTL_SECONDS),
      ),
    );
    if (taken === 0) {
      throw new AiRateLimitedError();
    }
    let released = false;
    return {
      release: async () => {
        if (!released) {
          released = true;
          await this.redis.eval(RELEASE, 1, slots);
        }
      },
    };
  }

  private async increment(key: string, ttlSeconds: number): Promise<number> {
    return Number(await this.redis.eval(INCREMENT, 1, key, String(ttlSeconds)));
  }
}
