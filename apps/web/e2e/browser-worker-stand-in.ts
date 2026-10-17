import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseXbCommand,
  XB_COMMANDS_QUEUE,
  XB_KEYS,
  XB_REPORT,
  XB_RESULTS_QUEUE,
  xbCommandName,
  type XbReport,
} from '@smp/x-browser';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

// A stand-in for the browser worker in the end-to-end tests (guide step 6.4): it takes the start
// of a login from xb-commands, reports that X asks for a code, pops the code the API pushed and
// reports the sign-in with a session it makes up. There is no browser and no X; the sealed
// credentials and codes stay closed, it only checks that they do not travel in plain text.

export const STAND_IN_USER = {
  id: '1846000000000000999',
  handle: 'smp_e2e',
  name: 'SMP E2E',
  avatarUrl: null,
};

export interface SeenLogin {
  loginSessionId: string;
  /** The password of the test turned up in the job as it is. */
  passwordInPlain: boolean;
  /** The code arrived in the list of the login. */
  codeArrived: boolean;
  /** The sealed code held the code as it is. */
  codeInPlain: boolean;
}

export interface BrowserWorkerStandIn {
  readonly logins: SeenLogin[];
  close(): Promise<void>;
}

/** REDIS_URL from the environment, else from the root .env the stack runs with. */
function redisUrl(): string {
  const fromEnvironment = process.env['REDIS_URL'];
  if (fromEnvironment) {
    return fromEnvironment;
  }
  const line = readFileSync(resolve(__dirname, '../../../.env'), 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('REDIS_URL='));
  return line?.slice('REDIS_URL='.length).trim() || 'redis://127.0.0.1:6379';
}

export async function startBrowserWorkerStandIn(secrets: {
  password: string;
  code: string;
}): Promise<BrowserWorkerStandIn> {
  const url = redisUrl();
  const reports = new Queue(XB_RESULTS_QUEUE, { connection: { url } });
  const inbox = new Redis(url, { maxRetriesPerRequest: null });
  const logins: SeenLogin[] = [];
  const report = (item: XbReport) => reports.add(XB_REPORT, item, { removeOnComplete: true });
  const worker = new Worker(
    XB_COMMANDS_QUEUE,
    async (job) => {
      if (job.name !== xbCommandName('login.start')) {
        return { ok: false, error: { code: 'UNAVAILABLE', message: 'The stand-in only signs in.' } };
      }
      const command = parseXbCommand('login.start', job.data);
      const scope = {
        organizationId: command.organizationId,
        workspaceId: command.workspaceId,
        loginSessionId: command.loginSessionId,
      };
      const seen: SeenLogin = {
        loginSessionId: command.loginSessionId,
        passwordInPlain: JSON.stringify(job.data).includes(secrets.password),
        codeArrived: false,
        codeInPlain: false,
      };
      logins.push(seen);
      await report({ kind: 'login.status', ...scope, status: 'AWAITING_2FA' });
      const popped = await inbox.blpop(XB_KEYS.loginInput(command.loginSessionId), 60);
      seen.codeArrived = popped !== null;
      seen.codeInPlain = popped !== null && Buffer.from(popped[1], 'base64').includes(secrets.code);
      await report(
        popped
          ? {
              kind: 'login.succeeded',
              ...scope,
              user: STAND_IN_USER,
              session: Buffer.from('a session of the stand-in').toString('base64'),
            }
          : { kind: 'login.failed', ...scope, failure: 'TIMEOUT' },
      );
      return { ok: true, data: {} };
    },
    { connection: { url, maxRetriesPerRequest: null } },
  );
  await worker.waitUntilReady();
  return {
    logins,
    close: async () => {
      await worker.close();
      await reports.close();
      inbox.disconnect();
    },
  };
}
