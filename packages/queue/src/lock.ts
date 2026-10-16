import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type Redis from 'ioredis';

// A Redis lock for work that must not run twice at once, for example the token refresh of a
// connection (lock:conn:{id}, architecture 7). SET NX PX takes it with a random token; only the
// holder of that token can release or extend it, because the Lua scripts compare first. The TTL
// must outlast the work, or the work extends it in time. A release that fails leaves the lock to
// its TTL.

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export class LockNotAcquiredError extends Error {
  constructor(readonly key: string) {
    super(`The lock ${key} is held by someone else.`);
    this.name = 'LockNotAcquiredError';
  }
}

export interface HeldLock {
  readonly key: string;
  /** Sets the remaining time to ttlMs; false when the lock was lost meanwhile. */
  extend(ttlMs: number): Promise<boolean>;
}

export interface LockOptions {
  /** How long to wait for a busy lock; 0 gives up at once. */
  waitMs?: number;
  /** The pause between two tries while waiting. */
  retryDelayMs?: number;
}

/** Runs fn while holding the lock; throws LockNotAcquiredError when it stays busy. */
export async function withLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  fn: (lock: HeldLock) => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    if ((await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK') {
      break;
    }
    if (Date.now() >= deadline) {
      throw new LockNotAcquiredError(key);
    }
    await sleep(options.retryDelayMs ?? 100);
  }
  const lock: HeldLock = {
    key,
    extend: async (ms) => (await redis.eval(EXTEND, 1, key, token, String(ms))) === 1,
  };
  try {
    return await fn(lock);
  } finally {
    await redis.eval(RELEASE, 1, key, token).catch(() => undefined);
  }
}
