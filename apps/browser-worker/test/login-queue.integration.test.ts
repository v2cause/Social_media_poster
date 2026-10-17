import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { sealerFromEnv } from '@smp/crypto';
import { createLogger } from '@smp/observability';
import { startRedis, type StartedRedis } from '@smp/testing';
import {
  parseXbReport,
  XB_COMMANDS_QUEUE,
  XB_KEYS,
  XB_REDIS_ACL,
  XB_RESULTS_QUEUE,
  xbLoginAad,
  xbSessionAad,
  type XbReport,
} from '@smp/x-browser';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StorageState, TaskEnd, TaskOptions } from '../src/browser-host';
import { codeInbox, LoginRunner } from '../src/login-runner';
import { processCommand } from '../src/processor';

// Guide step 6.4 through Redis and BullMQ, as the user browser-worker: the start of a login comes
// with the credentials sealed, the browser worker reports that X asks for a code and pops the code
// the API pushed, the session goes back sealed for the X user, and the job leaves Redis as soon as
// it ends. The browser is a stand-in; the login flow runs in the tests of packages/x-browser.

const PASSWORD = 'browser-worker-login-test';
const X_PASSWORD = 'the-password-of-the-x-account';
const KEYS = { SESSION_KEKS: `k1:${randomBytes(32).toString('base64')}`, SESSION_KEK_ACTIVE: 'k1' };
const after: StorageState = { cookies: [], origins: [{ origin: 'https://x.com', localStorage: [] }] };
const user = { id: '1234567890', handle: 'smp_demo', name: 'SMP Demo', avatarUrl: null };

const host = {
  async run<T>(task: TaskOptions, work: (page: Page) => Promise<T>): Promise<TaskEnd<T>> {
    expect(task).toEqual({ storageState: null, locale: 'de' });
    return { result: { ok: true, value: await work({} as Page) }, storageState: after, refusedHosts: [] };
  },
};

describe('the login of X through the queue', () => {
  let started: StartedRedis | undefined;
  let admin: Redis | undefined;
  let own: Redis | undefined;
  let commands: Queue | undefined;
  let results: Queue | undefined;
  let reports: Queue | undefined;
  let worker: Worker | undefined;
  const sealer = sealerFromEnv('sessions', KEYS);
  const codes: (string | null)[] = [];

  const reportsOf = async (): Promise<XbReport[]> =>
    (await (results as Queue).getJobs(['waiting'], 0, -1, true)).map((job) => parseXbReport(job.data));
  const waitForReports = async (count: number): Promise<XbReport[]> => {
    for (let waited = 0; waited < 200; waited += 1) {
      const found = await reportsOf();
      if (found.length >= count) {
        return found;
      }
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${String(count)} reports`);
  };

  beforeAll(async () => {
    started = await startRedis({ args: ['--user', 'browser-worker', 'on', `>${PASSWORD}`, ...XB_REDIS_ACL] });
    const restricted = started.url.replace('redis://', `redis://browser-worker:${PASSWORD}@`);
    admin = new Redis(started.url);
    own = new Redis(restricted, { maxRetriesPerRequest: null });
    const producer = new Queue(XB_RESULTS_QUEUE, { connection: { url: restricted } });
    reports = producer;
    const now = (): Date => new Date();
    const runner = new LoginRunner({
      host,
      sealer,
      login: async (_page, credentials, hooks) => {
        expect(credentials).toEqual({ username: 'smp_demo', password: X_PASSWORD });
        codes.push(await hooks.code(1));
        return user;
      },
      nextCode: codeInbox(own, now),
      report: async (item) => {
        await producer.add('xb.result', item, { removeOnComplete: true });
      },
      killed: async () => (await (own as Redis).exists(XB_KEYS.kill)) === 1,
      now,
      selectorsVersion: 'x-v1',
      logger: createLogger({ service: 'browser-worker', environment: 'test', level: 'silent' }),
    });
    const unexpected = () => Promise.reject(new Error('no account command expected'));
    worker = new Worker(
      XB_COMMANDS_QUEUE,
      (job, token) => processCommand(job, token, { run: unexpected, login: (cmd) => runner.run(cmd) }, now),
      { connection: { url: restricted, maxRetriesPerRequest: null }, maxStalledCount: 0 },
    );
    commands = new Queue(XB_COMMANDS_QUEUE, { connection: { url: started.url } });
    results = new Queue(XB_RESULTS_QUEUE, { connection: { url: started.url } });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await reports?.close();
    own?.disconnect();
    await commands?.close();
    await results?.close();
    admin?.disconnect();
    await started?.stop();
  });

  it('waits for the code of the two-factor login and reports the sealed session', async () => {
    const workspaceId = randomUUID();
    const loginSessionId = randomUUID();
    const credentials = await sealer.seal(
      JSON.stringify({ username: 'smp_demo', password: X_PASSWORD }),
      xbLoginAad(workspaceId, loginSessionId, 'credentials'),
    );
    const jobId = `xb.login.start.${loginSessionId}`;
    // As the API queues it: one attempt, gone as soon as it ends.
    await (commands as Queue).add(
      'xb.login.start',
      {
        commandId: randomUUID(),
        deadline: new Date(Date.now() + 60_000).toISOString(),
        organizationId: randomUUID(),
        workspaceId,
        loginSessionId,
        locale: 'de',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        credentials: Buffer.from(credentials).toString('base64'),
      },
      { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true },
    );

    const [asked] = await waitForReports(1);
    expect(asked).toMatchObject({ kind: 'login.status', loginSessionId, status: 'AWAITING_2FA' });
    // As the API pushes it.
    const code = await sealer.seal('123456', xbLoginAad(workspaceId, loginSessionId, 'code'));
    await (admin as Redis).rpush(XB_KEYS.loginInput(loginSessionId), Buffer.from(code).toString('base64'));

    const [, succeeded] = await waitForReports(2);
    expect(codes).toEqual(['123456']);
    expect(succeeded).toMatchObject({ kind: 'login.succeeded', loginSessionId, workspaceId, user });
    const session = succeeded?.kind === 'login.succeeded' ? succeeded.session : '';
    await expect(
      sealer.open(Buffer.from(session, 'base64'), xbSessionAad(workspaceId, user.id)),
    ).resolves.toBe(JSON.stringify(after));
    for (
      let waited = 0;
      (await (commands as Queue).getJob(jobId)) !== undefined && waited < 100;
      waited += 1
    ) {
      await sleep(50);
    }
    await expect((commands as Queue).getJob(jobId)).resolves.toBeUndefined();
    await expect((admin as Redis).exists(XB_KEYS.loginInput(loginSessionId))).resolves.toBe(0);
  });
});
