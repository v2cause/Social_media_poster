import { randomUUID } from 'node:crypto';

import { startRedis, type StartedRedis } from '@smp/testing';
import { XB_KEYS } from '@smp/x-browser';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccountGuard, LOCK_TTL_MS, POST_SPACING_MS } from '../src/account-guard';

// Guide step 6.2 on Redis: one task per account at a time, two minutes between its posts, and a
// lock that only its holder releases.

describe('AccountGuard', () => {
  let started: StartedRedis | undefined;
  let redis: Redis | undefined;
  const guard = () => new AccountGuard(redis as Redis);

  beforeAll(async () => {
    started = await startRedis();
    redis = new Redis(started.url);
  });

  afterAll(async () => {
    redis?.disconnect();
    await started?.stop();
  });

  it('lets one task of an account run at a time and others meanwhile', async () => {
    const account = randomUUID();
    const first = await guard().acquire(account, 'command-1', false);
    expect(first.kind).toBe('acquired');
    const ttl = await (redis as Redis).pttl(XB_KEYS.lock(account));
    expect(ttl).toBeGreaterThan(LOCK_TTL_MS - 5_000);

    const second = await guard().acquire(account, 'command-2', false);
    expect(second).toEqual({ kind: 'busy', reason: 'locked', waitMs: 15_000 });
    expect((await guard().acquire(randomUUID(), 'command-3', true)).kind).toBe('acquired');

    if (first.kind === 'acquired') {
      await first.release();
    }
    expect((await guard().acquire(account, 'command-2', false)).kind).toBe('acquired');
  });

  it('releases only the lock of its own command', async () => {
    const account = randomUUID();
    await (redis as Redis).set(XB_KEYS.lock(account), 'someone-else', 'PX', 2_000);
    const busy = await guard().acquire(account, 'command-1', false);
    expect(busy).toMatchObject({ kind: 'busy', reason: 'locked' });
    expect(busy.kind === 'busy' ? busy.waitMs : 0).toBeLessThanOrEqual(2_000);

    await (redis as Redis).del(XB_KEYS.lock(account));
    const mine = await guard().acquire(account, 'command-1', false);
    await (redis as Redis).set(XB_KEYS.lock(account), 'command-2', 'PX', 60_000);
    if (mine.kind === 'acquired') {
      await mine.release();
    }
    await expect((redis as Redis).get(XB_KEYS.lock(account))).resolves.toBe('command-2');
  });

  it('keeps two minutes between the posts of an account, not between its other tasks', async () => {
    const account = randomUUID();
    await guard().spaced(account);
    const post = await guard().acquire(account, 'command-1', true);
    expect(post).toMatchObject({ kind: 'busy', reason: 'spacing' });
    const wait = post.kind === 'busy' ? post.waitMs : 0;
    expect(wait).toBeGreaterThan(POST_SPACING_MS - 5_000);
    expect(wait).toBeLessThanOrEqual(POST_SPACING_MS);
    await expect((redis as Redis).exists(XB_KEYS.lock(account))).resolves.toBe(0);

    const metrics = await guard().acquire(account, 'command-2', false);
    expect(metrics.kind).toBe('acquired');
  });
});
