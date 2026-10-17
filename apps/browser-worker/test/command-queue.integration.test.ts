import { randomBytes, randomUUID } from 'node:crypto';

import { sealerFromEnv } from '@smp/crypto';
import { createLogger } from '@smp/observability';
import { startRedis, type StartedRedis } from '@smp/testing';
import {
  parseXbReport,
  XB_COMMANDS_QUEUE,
  XB_KEYS,
  XB_REDIS_ACL,
  XB_REPORT,
  XB_RESULTS_QUEUE,
  xbSessionAad,
  type XbReport,
} from '@smp/x-browser';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AccountGuard } from '../src/account-guard';
import type { StorageState, TaskEnd, TaskOptions } from '../src/browser-host';
import { CommandRunner, type XbFlows } from '../src/command-runner';
import { processCommand } from '../src/processor';

// Guide step 6.2 through Redis and BullMQ, as the user browser-worker: a command comes back as the
// return value of its job, the session goes out sealed on xb-results, the kill switch refuses and
// a busy account waits as a delayed job. The browser is a stand-in; the flows run in the tests of
// packages/x-browser.

const PASSWORD = 'browser-worker-queue-test';
const KEYS = { SESSION_KEKS: `k1:${randomBytes(32).toString('base64')}`, SESSION_KEK_ACTIVE: 'k1' };
const before: StorageState = { cookies: [], origins: [] };
const after: StorageState = { cookies: [], origins: [{ origin: 'https://x.com', localStorage: [] }] };
const user = { id: '1234567890', handle: 'smp_demo', name: 'SMP Demo', avatarUrl: null };

const host = {
  async run<T>(task: TaskOptions, work: (page: Page) => Promise<T>): Promise<TaskEnd<T>> {
    expect(task.storageState).toEqual(before);
    return { result: { ok: true, value: await work({} as Page) }, storageState: after, refusedHosts: [] };
  },
};
const unexpected = (): Promise<never> => Promise.reject(new Error('flow not expected'));
const flows: XbFlows = {
  selectorsVersion: 'x-v1',
  publish: unexpected,
  reconcile: unexpected,
  metrics: unexpected,
  'account-metrics': unexpected,
  delete: unexpected,
  'verify-session': () => Promise.resolve({ user }),
  canary: unexpected,
};

describe('commands through the queue', () => {
  let started: StartedRedis | undefined;
  let admin: Redis | undefined;
  let commands: Queue | undefined;
  let events: QueueEvents | undefined;
  let results: Queue | undefined;
  let worker: Worker | undefined;
  let reports: Queue | undefined;
  let own: Redis | undefined;
  const sealer = sealerFromEnv('sessions', KEYS);

  const workspaceId = randomUUID();
  const sealedSession = async () =>
    Buffer.from(await sealer.seal(JSON.stringify(before), xbSessionAad(workspaceId, user.id))).toString(
      'base64',
    );
  const command = async (accountId = randomUUID()) => ({
    commandId: randomUUID(),
    deadline: new Date(Date.now() + 60_000).toISOString(),
    target: {
      organizationId: randomUUID(),
      workspaceId,
      connectionId: randomUUID(),
      accountId,
      externalUserId: user.id,
      handle: user.handle,
      locale: 'de',
      session: await sealedSession(),
    },
  });

  beforeAll(async () => {
    started = await startRedis({ args: ['--user', 'browser-worker', 'on', `>${PASSWORD}`, ...XB_REDIS_ACL] });
    const restricted = started.url.replace('redis://', `redis://browser-worker:${PASSWORD}@`);
    admin = new Redis(started.url);
    own = new Redis(restricted, { maxRetriesPerRequest: null });
    const producer = new Queue(XB_RESULTS_QUEUE, { connection: { url: restricted } });
    reports = producer;
    const ownRedis = own;
    const now = (): Date => new Date();
    const runner = new CommandRunner({
      host,
      guard: new AccountGuard(ownRedis),
      sealer,
      flows,
      media: () => Promise.reject(new Error('no media')),
      report: async (item: XbReport) => {
        await producer.add(XB_REPORT, item, { removeOnComplete: true });
      },
      killed: async () => (await ownRedis.exists(XB_KEYS.kill)) === 1,
      now,
      logger: createLogger({ service: 'browser-worker', environment: 'test', level: 'silent' }),
    });
    worker = new Worker(
      XB_COMMANDS_QUEUE,
      (job, token) =>
        processCommand(
          job,
          token,
          {
            run: (operation, cmd) => runner.run(operation, cmd),
            login: () => Promise.resolve({ ok: false, error: { code: 'UNAVAILABLE', message: 'no login' } }),
          },
          now,
        ),
      { connection: { url: restricted, maxRetriesPerRequest: null }, maxStalledCount: 0 },
    );
    commands = new Queue(XB_COMMANDS_QUEUE, { connection: { url: started.url } });
    events = new QueueEvents(XB_COMMANDS_QUEUE, { connection: { url: started.url } });
    results = new Queue(XB_RESULTS_QUEUE, { connection: { url: started.url } });
    await events.waitUntilReady();
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await reports?.close();
    own?.disconnect();
    await events?.close();
    await commands?.close();
    await results?.close();
    admin?.disconnect();
    await started?.stop();
  });

  const send = async (data: unknown) => {
    const job = await (commands as Queue).add('xb.verify-session', data, { removeOnComplete: true });
    return job.waitUntilFinished(events as QueueEvents, 20_000) as Promise<unknown>;
  };

  it('answers with the return value of the job and reports the sealed session', async () => {
    const data = await command();
    await expect(send(data)).resolves.toEqual({ ok: true, data: { user } });

    const [job] = await (results as Queue).getJobs(['waiting'], 0, 1);
    const report = parseXbReport(job?.data);
    expect(report).toMatchObject({ kind: 'session.updated', workspaceId, externalUserId: user.id });
    const sealed = report.kind === 'session.updated' ? report.session : '';
    await expect(
      sealer.open(Buffer.from(sealed, 'base64'), xbSessionAad(workspaceId, user.id)),
    ).resolves.toBe(JSON.stringify(after));
    expect(sealed).not.toContain('x.com');
  });

  it('refuses every command while the kill switch is on', async () => {
    await (admin as Redis).set(XB_KEYS.kill, '1');
    try {
      await expect(send(await command())).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNAVAILABLE' },
      });
    } finally {
      await (admin as Redis).del(XB_KEYS.kill);
    }
  });

  it('lets a command of a busy account wait as a delayed job and then runs it', async () => {
    const accountId = randomUUID();
    await (admin as Redis).set(XB_KEYS.lock(accountId), 'another-command', 'PX', 1_500);
    const startedAt = Date.now();
    await expect(send(await command(accountId))).resolves.toMatchObject({ ok: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
  });
});
