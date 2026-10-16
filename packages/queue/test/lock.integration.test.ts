import { setTimeout as sleep } from 'node:timers/promises';

import { startRedis, type StartedRedis } from '@smp/testing';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LockNotAcquiredError, withLock } from '../src';

// Guide step 4.3: withLock takes the lock with SET NX PX and only its holder releases or extends
// it, so an expired lock taken over by someone else stays theirs.

describe('withLock', () => {
  let redis: StartedRedis | undefined;
  let client: Redis | undefined;

  const connection = (): Redis => {
    if (!client) {
      throw new Error('Redis is not connected');
    }
    return client;
  };

  beforeAll(async () => {
    redis = await startRedis();
    client = new Redis(redis.url);
  });

  afterAll(async () => {
    client?.disconnect();
    await redis?.stop();
  });

  it('runs one holder at a time and lets a waiting caller in after the release', async () => {
    const order: string[] = [];
    const first = withLock(connection(), 'lock:conn:1', 5_000, async () => {
      order.push('first:start');
      await sleep(200);
      order.push('first:end');
    });
    await sleep(20);
    await expect(
      withLock(connection(), 'lock:conn:1', 5_000, () => Promise.resolve('x')),
    ).rejects.toBeInstanceOf(LockNotAcquiredError);
    const second = withLock(
      connection(),
      'lock:conn:1',
      5_000,
      () => {
        order.push('second');
        return Promise.resolve('done');
      },
      { waitMs: 2_000, retryDelayMs: 20 },
    );

    await first;
    await expect(second).resolves.toBe('done');
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(await connection().exists('lock:conn:1')).toBe(0);
  });

  it('releases on errors too', async () => {
    await expect(
      withLock(connection(), 'lock:conn:2', 5_000, () => Promise.reject(new Error('refresh failed'))),
    ).rejects.toThrow('refresh failed');
    expect(await connection().exists('lock:conn:2')).toBe(0);
  });

  it('never releases or extends a lock that expired and went to someone else', async () => {
    let extendedLate: boolean | undefined;
    await withLock(connection(), 'lock:conn:3', 100, async (lock) => {
      await expect(lock.extend(300)).resolves.toBe(true);
      expect(await connection().pttl('lock:conn:3')).toBeGreaterThan(150);
      await sleep(400);
      // Expired: another worker takes it.
      await connection().set('lock:conn:3', 'other-token', 'PX', 5_000);
      extendedLate = await lock.extend(1_000);
    });

    expect(extendedLate).toBe(false);
    expect(await connection().get('lock:conn:3')).toBe('other-token');
  });
});
