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
// queues. BullMQ works under it; the queues and locks of the platform stay out of reach. Step 8.4
// (ADR 0039): Redis knows no user without a password, so no other path leads around this ACL.

const PASSWORD = 'browser-worker-test-password';
const APP_PASSWORD = 'app-test-password';

/** The arguments of the Redis command of compose.yaml, with test passwords. */
const composeArgs = (): string[] => {
  const compose = readFileSync(join(__dirname, '../../../compose.yaml'), 'utf8');
  const command = /\n {2}redis:\n[\s\S]*?\n {4}command:\n((?: {6}(?:- .+|#.*)\n)+)/.exec(compose)?.[1] ?? '';
  return command
    .trimEnd()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.replace(/^ {6}- /, '').replace(/^'(.*)'$/, '$1'))
    .map((item) =>
      item
        .replace('${XB_REDIS_PASSWORD:?set XB_REDIS_PASSWORD in .env}', PASSWORD)
        .replace('${REDIS_APP_PASSWORD:?set REDIS_APP_PASSWORD in .env}', APP_PASSWORD),
    )
    .slice(1);
};

/** The rules of one user in the Redis command of compose.yaml, up to the next user. */
const composeUser = (name: string): string[] => {
  const items = composeArgs();
  const start = items.findIndex((item, index) => item === name && items[index - 1] === '--user');
  if (start < 0) {
    return [];
  }
  const end = items.indexOf('--user', start);
  return items.slice(start + 1, end < 0 ? undefined : end);
};

/** The ACL rules of the user browser-worker, after "on" and the password. */
const composeAcl = (): string[] => composeUser('browser-worker').slice(2);

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

    // The job stays a minute: removed on completion, it can be gone before the wait looks at it.
    const job = await commands.add(
      'xb.verify-session',
      { commandId: 'c-1' },
      { removeOnComplete: { age: 60 } },
    );
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

describe('the users of Redis in compose.yaml', () => {
  let started: StartedRedis | undefined;
  const clients: Redis[] = [];

  beforeAll(async () => {
    started = await startRedis({
      args: composeArgs().filter((item) => item !== '--appendonly' && item !== 'yes'),
    });
  });

  afterAll(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await started?.stop();
  });

  const connect = (credentials: string): Redis => {
    const url = (started?.url ?? '').replace('redis://', `redis://${credentials}`);
    // Without the ready check: it sends INFO, which a connection without a user may not run.
    const client = new Redis(url, {
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      enableReadyCheck: false,
      retryStrategy: () => null,
    });
    // A refused sign-in also arrives as an error event; the tests look at the command replies.
    client.on('error', () => undefined);
    clients.push(client);
    return client;
  };

  it('lets nobody in without a password', async () => {
    const anonymous = connect('');
    await anonymous.connect();
    await expect(anonymous.get('smp:access:anyone')).rejects.toThrow(/NOAUTH/);
    await expect(anonymous.set('smp:access:anyone', 'x')).rejects.toThrow(/NOAUTH/);
    // The default user is off, whatever the password.
    await expect(anonymous.call('AUTH', 'default', 'anything')).rejects.toThrow(/WRONGPASS/);
  });

  it('gives API and worker every key and channel under the user app', async () => {
    const app = connect(`app:${APP_PASSWORD}@`);
    await app.set('smp:access:user-1', 'cached');
    await expect(app.get('smp:access:user-1')).resolves.toBe('cached');
    await expect(app.publish('smp:events', 'x')).resolves.toBe(0);
    const anonymous = connect('');
    await anonymous.connect();
    await expect(anonymous.call('AUTH', 'app', 'wrong-password')).rejects.toThrow(/WRONGPASS/);
  });

  it('keeps the user app from dangerous commands, apart from the INFO that BullMQ asks', async () => {
    const app = connect(`app:${APP_PASSWORD}@`);
    await expect(app.info('server')).resolves.toContain('redis_version');
    await expect(app.flushall()).rejects.toThrow(/NOPERM/);
    await expect(app.keys('smp:*')).rejects.toThrow(/NOPERM/);
    await expect(app.call('CONFIG', 'GET', 'maxmemory-policy')).rejects.toThrow(/NOPERM/);
    await expect(app.call('ACL', 'LIST')).rejects.toThrow(/NOPERM/);
  });

  it('lets the healthcheck only PING', async () => {
    const health = connect('health:unused@');
    await expect(health.ping()).resolves.toBe('PONG');
    await expect(health.get('smp:access:user-1')).rejects.toThrow(/NOPERM/);
  });

  it('keeps the browser worker away from the keys of the platform', async () => {
    const restricted = connect(`browser-worker:${PASSWORD}@`);
    await expect(restricted.get('smp:access:user-1')).rejects.toThrow(/NOPERM/);
    await expect(restricted.set('smp:access:user-1', 'OWNER')).rejects.toThrow(/NOPERM/);
  });
});
