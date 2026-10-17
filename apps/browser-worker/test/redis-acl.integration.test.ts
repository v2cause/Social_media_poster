import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startRedis, type StartedRedis } from '@smp/testing';
import { XB_COMMANDS_QUEUE, XB_KEYS, XB_REDIS_ACL, XB_REPORT, XB_RESULTS_QUEUE } from '@smp/x-browser';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccountGuard } from '../src/account-guard';

// Guide step 6.2: inside the network the browser worker reaches only Redis, and there only as the
// user "browser-worker" with the ACL of compose.yaml: the keys of the X browser and its two
// queues. BullMQ works under it; the queues and locks of the platform stay out of reach.

const PASSWORD = 'browser-worker-test-password';

/** The ACL rules of the user browser-worker in the Redis command of compose.yaml. */
const composeAcl = (): string[] => {
  const compose = readFileSync(join(__dirname, '../../../compose.yaml'), 'utf8');
  const command = /\n {2}redis:\n[\s\S]*?\n {4}command:\n((?: {6}- .+\n)+)/.exec(compose)?.[1] ?? '';
  const items = command
    .trimEnd()
    .split('\n')
    .map((line) => line.replace(/^ {6}- /, '').replace(/^'(.*)'$/, '$1'));
  const user = items.indexOf('browser-worker');
  // After the name come "on" and the password.
  return user < 0 ? [] : items.slice(user + 3);
};

describe('the Redis user of the browser worker', () => {
  let started: StartedRedis | undefined;
  let admin = '';
  let restricted = '';
  const closing: { close(): Promise<unknown> }[] = [];
  const clients: Redis[] = [];

  beforeAll(async () => {
    started = await startRedis({
      args: ['--user', 'browser-worker', 'on', `>${PASSWORD}`, ...XB_REDIS_ACL],
    });
    admin = started.url;
    restricted = admin.replace('redis://', `redis://browser-worker:${PASSWORD}@`);
  });

  afterAll(async () => {
    for (const item of closing.reverse()) {
      await item.close().catch(() => undefined);
    }
    for (const client of clients) {
      client.disconnect();
    }
    await started?.stop();
  });

  const client = (url: string): Redis => {
    const created = new Redis(url);
    clients.push(created);
    return created;
  };

  it('is the user compose.yaml starts Redis with', () => {
    expect(composeAcl()).toEqual(XB_REDIS_ACL);
  });

  it('works the command queue and reports on the result queue with BullMQ', async () => {
    const worker = new Worker(XB_COMMANDS_QUEUE, (job) => Promise.resolve({ echoed: job.data as unknown }), {
      connection: { url: restricted, maxRetriesPerRequest: null },
      maxStalledCount: 0,
    });
    const errors: string[] = [];
    worker.on('error', (error) => errors.push(error.message));
    const results = new Queue(XB_RESULTS_QUEUE, { connection: { url: restricted } });
    const commands = new Queue(XB_COMMANDS_QUEUE, { connection: { url: admin } });
    const events = new QueueEvents(XB_COMMANDS_QUEUE, { connection: { url: admin } });
    closing.push(commands, events, results, worker);
    await events.waitUntilReady();

    const job = await commands.add('xb.verify-session', { commandId: 'c-1' }, { removeOnComplete: true });
    await expect(job.waitUntilFinished(events, 20_000)).resolves.toEqual({ echoed: { commandId: 'c-1' } });
    await results.add(XB_REPORT, { kind: 'drift' }, { removeOnComplete: true });
    await expect(new Queue(XB_RESULTS_QUEUE, { connection: { url: admin } }).getWaitingCount()).resolves.toBe(
      1,
    );
    expect(errors).toEqual([]);
  });

  it('guards the accounts and reads the kill switch, which it cannot lift', async () => {
    const own = client(restricted);
    const guard = new AccountGuard(own);
    expect((await guard.acquire('account-1', 'c-1', true)).kind).toBe('acquired');
    await guard.spaced('account-1');

    await client(admin).set(XB_KEYS.kill, '1');
    await expect(own.exists(XB_KEYS.kill)).resolves.toBe(1);
    await expect(own.del(XB_KEYS.kill)).rejects.toThrow(/NOPERM/);
    await expect(own.set(XB_KEYS.kill, '0')).rejects.toThrow(/NOPERM/);
  });

  it('reaches neither the platform nor the admin commands', async () => {
    const own = client(restricted);
    for (const attempt of [
      () => own.get('bull:publish:1'),
      () => own.get('lock:conn:1'),
      () => own.lpush('bull:notifications:wait', 'x'),
      () => own.eval("return redis.call('get', KEYS[1])", 1, 'session:x'),
      () => own.keys('*'),
      () => own.flushall(),
      () => own.config('GET', 'maxmemory'),
      () => own.publish('smp:events', 'x'),
    ]) {
      await expect(attempt()).rejects.toThrow(/NOPERM/);
    }
  });
});
