import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { BrowserLogin, BrowserLoginCommand } from '@smp/core';
import { startRedis, type StartedRedis } from '@smp/testing';
import { parseXbCommand, XB_COMMANDS_QUEUE, XB_KEYS } from '@smp/x-browser';
import { Queue, Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BullBrowserLoginQueue, RedisBrowserLoginStore } from '../src';

// Guide step 6.4 on Redis: a login lives as a hash outside the keys of the browser worker and
// takes one step at a time, its codes go to the list the browser worker pops, the starts count
// per workspace and hour, and the job of a start leaves Redis as soon as it ends.

const waitFor = async (what: string, condition: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
};

describe('the logins of X in Redis', () => {
  let started: StartedRedis | undefined;
  let redis: Redis | undefined;
  let queue: Queue | undefined;

  const ready = () => {
    if (!started || !redis || !queue) {
      throw new Error('Redis is not running');
    }
    return { started, redis, queue };
  };
  const login = (overrides: Partial<BrowserLogin> = {}): BrowserLogin => ({
    id: randomUUID(),
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    userId: randomUUID(),
    status: 'STARTING',
    failure: null,
    accountId: null,
    reconnectAccountId: null,
    locale: 'de',
    startedAt: new Date('2026-10-17T08:00:00.000Z'),
    // Ahead of the clock of Redis, which sets the expiry from it.
    expiresAt: new Date(Date.now() + 5 * 60_000),
    ...overrides,
  });

  beforeAll(async () => {
    started = await startRedis();
    redis = new Redis(started.url);
    queue = new Queue(XB_COMMANDS_QUEUE, { connection: { url: started.url } });
  });

  afterAll(async () => {
    await queue?.close();
    redis?.disconnect();
    await started?.stop();
  });

  it('keeps a login until a quarter of an hour after its end, outside the keys of the browser worker', async () => {
    const { redis } = ready();
    const store = new RedisBrowserLoginStore(redis);
    const created = login({ reconnectAccountId: randomUUID() });
    await store.create(created);

    await expect(store.find(created.id)).resolves.toEqual(created);
    await expect(store.find(randomUUID())).resolves.toBeNull();
    const key = `x-browser:login:${created.id}`;
    expect(await redis.keys(`*${created.id}*`)).toEqual([key]);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(19 * 60_000);
    expect(ttl).toBeLessThanOrEqual(20 * 60_000);

    // A hash that does not parse counts as missing.
    const damaged = randomUUID();
    await redis.hset(`x-browser:login:${damaged}`, { id: damaged, status: 'SOMETHING' });
    await expect(store.find(damaged)).resolves.toBeNull();
  });

  it('takes a step only from the given statuses, and one of two at the same time', async () => {
    const store = new RedisBrowserLoginStore(ready().redis);
    const created = login();
    await store.create(created);

    await expect(store.transition(created.id, ['AWAITING_2FA'], { status: 'VERIFYING' })).resolves.toBeNull();
    await expect(store.transition(created.id, ['STARTING'], { status: 'AWAITING_2FA' })).resolves.toEqual({
      ...created,
      status: 'AWAITING_2FA',
    });
    const ends = await Promise.all([
      store.transition(created.id, ['AWAITING_2FA'], { status: 'FAILED', failure: 'TIMEOUT' }),
      store.transition(created.id, ['AWAITING_2FA'], { status: 'SUCCEEDED', accountId: randomUUID() }),
    ]);
    expect(ends.filter((end) => end !== null)).toHaveLength(1);
    await expect(store.find(created.id)).resolves.toEqual(ends.find((end) => end !== null));
    await expect(store.transition(randomUUID(), ['STARTING'], { status: 'FAILED' })).resolves.toBeNull();
  });

  it('hands the codes to the list of the browser worker and counts the starts per hour', async () => {
    const { redis } = ready();
    const store = new RedisBrowserLoginStore(redis);
    const id = randomUUID();
    await store.pushCode(id, Buffer.from('sealed-1'));
    await store.pushCode(id, Buffer.from('sealed-2'));

    const key = XB_KEYS.loginInput(id);
    const codes = await redis.lrange(key, 0, -1);
    expect(codes.map((code) => Buffer.from(code, 'base64').toString())).toEqual(['sealed-1', 'sealed-2']);
    expect(await redis.pttl(key)).toBeGreaterThan(4 * 60_000);

    const workspaceId = randomUUID();
    await expect(store.countStart(workspaceId, new Date('2026-10-17T08:10:00Z'))).resolves.toBe(1);
    await expect(store.countStart(workspaceId, new Date('2026-10-17T08:59:59Z'))).resolves.toBe(2);
    await expect(store.countStart(workspaceId, new Date('2026-10-17T09:00:00Z'))).resolves.toBe(1);
    await expect(store.countStart(randomUUID(), new Date('2026-10-17T08:10:00Z'))).resolves.toBe(1);
  });

  it('queues the start once per login and drops its job when it ends, done or failed', async () => {
    const { started, queue } = ready();
    const command = (): BrowserLoginCommand => ({
      commandId: randomUUID(),
      loginSessionId: randomUUID(),
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      locale: 'en',
      deadline: new Date('2026-10-17T08:02:00Z'),
      expiresAt: new Date('2026-10-17T08:05:00Z'),
      credentialsSealed: Buffer.from('sealed credentials'),
    });
    const logins = new BullBrowserLoginQueue(queue);
    const [done, failing] = [command(), command()];
    await logins.start(done);
    await logins.start(done);
    await logins.start(failing);

    const jobOf = (login: BrowserLoginCommand) => queue.getJob(`xb.login.start.${login.loginSessionId}`);
    const job = await jobOf(done);
    expect(job?.name).toBe('xb.login.start');
    expect(job?.opts).toMatchObject({ attempts: 1, removeOnComplete: true, removeOnFail: true });
    expect(parseXbCommand('login.start', job?.data)).toEqual({
      commandId: done.commandId,
      deadline: '2026-10-17T08:02:00.000Z',
      organizationId: done.organizationId,
      workspaceId: done.workspaceId,
      loginSessionId: done.loginSessionId,
      locale: 'en',
      expiresAt: '2026-10-17T08:05:00.000Z',
      credentials: Buffer.from('sealed credentials').toString('base64'),
    });
    expect(await queue.getWaitingCount()).toBe(2);

    const worker = new Worker(
      XB_COMMANDS_QUEUE,
      (taken: Job<{ loginSessionId: string }>) =>
        taken.data.loginSessionId === failing.loginSessionId
          ? Promise.reject(new Error('The browser is gone.'))
          : Promise.resolve({ ok: true, data: {} }),
      { connection: { url: started.url, maxRetriesPerRequest: null } },
    );
    try {
      await waitFor(
        'both jobs to leave Redis',
        async () => (await jobOf(done)) === undefined && (await jobOf(failing)) === undefined,
      );
    } finally {
      await worker.close();
    }
  });
});
