import { randomUUID } from 'node:crypto';

import type { Logger } from '@smp/observability';
import {
  drift,
  FlowError,
  XB_KEYS,
  xbLoginAad,
  xbSessionAad,
  type XbCommand,
  type XbReport,
  type XUser,
} from '@smp/x-browser';
import type Redis from 'ioredis';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import type { StorageState, TaskEnd, TaskOptions } from './browser-host';
import type { SessionSealer } from './command-runner';
import { codeInbox, LoginRunner, type LoginDependencies } from './login-runner';

// Guide step 6.4: the runner opens the credentials with the AAD of the login, reports AWAITING_2FA
// when X asks for a code and waits for it, seals the session for the X user who signed in, and
// reports why a login ended without one. Credentials and codes never reach a log line.

const NOW = new Date('2026-10-17T08:00:00Z');
const PASSWORD = 'a-password-that-must-never-be-logged';
const CODE = '482916';
const user: XUser = { id: '1234567890', handle: 'smp_demo', name: 'SMP Demo', avatarUrl: null };
const state: StorageState = {
  cookies: [
    {
      name: 'auth_token',
      value: 'secret-cookie-value',
      domain: '.x.com',
      path: '/',
      expires: 1_900_000_000,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
  ],
  origins: [],
};

const sealer: SessionSealer = {
  seal: (plaintext, aad) => Promise.resolve(Buffer.from(JSON.stringify({ plaintext, aad }))),
  open: (sealed, aad) => {
    const box = JSON.parse(Buffer.from(sealed).toString('utf8')) as { plaintext: string; aad: string };
    return box.aad === aad ? Promise.resolve(box.plaintext) : Promise.reject(new Error('wrong aad'));
  },
};
const box = (plaintext: string, aad: string): Buffer => Buffer.from(JSON.stringify({ plaintext, aad }));

const organizationId = randomUUID();
const workspaceId = randomUUID();

function command(overrides: Partial<XbCommand<'login.start'>> = {}): XbCommand<'login.start'> {
  const loginSessionId = overrides.loginSessionId ?? randomUUID();
  return {
    commandId: randomUUID(),
    deadline: '2026-10-17T08:02:00.000Z',
    organizationId,
    workspaceId,
    loginSessionId,
    locale: 'en',
    expiresAt: '2026-10-17T08:05:00.000Z',
    credentials: box(
      JSON.stringify({ username: 'smp_demo', password: PASSWORD }),
      xbLoginAad(workspaceId, loginSessionId, 'credentials'),
    ).toString('base64'),
    ...overrides,
  };
}

/** A page that only closes; a flow waiting on it fails once it closed. */
class FakePage {
  private readonly waiting: ((error: Error) => void)[] = [];

  close(): Promise<void> {
    for (const reject of this.waiting.splice(0)) {
      reject(new Error('Target page, context or browser has been closed'));
    }
    return Promise.resolve();
  }

  untilClosed(): Promise<never> {
    return new Promise((_resolve, reject) => {
      this.waiting.push(reject);
    });
  }
}

class FakeHost {
  readonly tasks: TaskOptions[] = [];
  readonly page = new FakePage();

  async run<T>(task: TaskOptions, work: (page: Page) => Promise<T>): Promise<TaskEnd<T>> {
    this.tasks.push(task);
    try {
      return {
        result: { ok: true, value: await work(this.page as unknown as Page) },
        storageState: state,
        refusedHosts: [],
      };
    } catch (error) {
      return { result: { ok: false, error }, storageState: state, refusedHosts: [] };
    }
  }
}

function setup(
  flow: LoginDependencies['login'],
  options: { killed?: boolean; codes?: (Uint8Array | null)[]; now?: () => Date } = {},
) {
  const host = new FakeHost();
  const reports: XbReport[] = [];
  const waits: { loginSessionId: string; until: Date }[] = [];
  const lines: string[] = [];
  const record = (fields: unknown, message: string) => {
    lines.push(JSON.stringify([fields, message]));
  };
  const codes = [...(options.codes ?? [])];
  const runner = new LoginRunner({
    host,
    sealer,
    login: flow,
    nextCode: (loginSessionId, until) => {
      waits.push({ loginSessionId, until });
      return Promise.resolve(codes.shift() ?? null);
    },
    report: (report) => {
      reports.push(report);
      return Promise.resolve();
    },
    killed: () => Promise.resolve(options.killed ?? false),
    now: options.now ?? (() => NOW),
    selectorsVersion: 'x-v1',
    logger: { info: record, warn: record } as unknown as Pick<Logger, 'info' | 'warn'>,
  });
  return { runner, host, reports, waits, lines };
}

describe('LoginRunner', () => {
  it('signs in, asks for the code through Redis and reports the session sealed for the X user', async () => {
    const login = command();
    const t = setup(
      async (_page, credentials, hooks) => {
        expect(credentials).toEqual({ username: 'smp_demo', password: PASSWORD });
        expect(await hooks.code(1)).toBe(CODE);
        return user;
      },
      { codes: [box(CODE, xbLoginAad(workspaceId, login.loginSessionId, 'code'))] },
    );

    await expect(t.runner.run(login)).resolves.toEqual({ ok: true, data: {} });

    expect(t.host.tasks).toEqual([{ storageState: null, locale: 'en' }]);
    expect(t.waits).toEqual([{ loginSessionId: login.loginSessionId, until: new Date(login.expiresAt) }]);
    const scope = { organizationId, workspaceId, loginSessionId: login.loginSessionId };
    expect(t.reports).toEqual([
      { kind: 'login.status', ...scope, status: 'AWAITING_2FA' },
      { kind: 'login.succeeded', ...scope, user, session: expect.any(String) as string },
    ]);
    const succeeded = t.reports[1];
    const session = succeeded?.kind === 'login.succeeded' ? succeeded.session : '';
    await expect(
      sealer.open(Buffer.from(session, 'base64'), xbSessionAad(workspaceId, user.id)),
    ).resolves.toBe(JSON.stringify(state));
    expect(t.lines.join('\n')).not.toMatch(new RegExp(`${PASSWORD}|${CODE}|smp_demo|secret-cookie-value`));
  });

  it('starts no browser while the kill switch is on or after the deadline', async () => {
    const never = () => Promise.reject(new Error('flow not expected'));
    const killed = setup(never, { killed: true });
    await expect(killed.runner.run(command())).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE' },
    });
    expect(killed.reports).toEqual([
      expect.objectContaining({ kind: 'login.failed', failure: 'UNAVAILABLE' }),
    ]);

    const late = setup(never, { now: () => new Date('2026-10-17T08:02:00Z') });
    await expect(late.runner.run(command())).resolves.toMatchObject({
      ok: false,
      error: { code: 'EXPIRED' },
    });
    expect(late.reports).toEqual([expect.objectContaining({ kind: 'login.failed', failure: 'UNAVAILABLE' })]);
    expect([...killed.host.tasks, ...late.host.tasks]).toEqual([]);
  });

  it('fails when the credentials do not open with the AAD of the login', async () => {
    const t = setup(() => Promise.reject(new Error('flow not expected')));
    await t.runner.run(command({ credentials: box('{}', 'another-aad').toString('base64') }));

    expect(t.reports).toEqual([expect.objectContaining({ kind: 'login.failed', failure: 'TRANSIENT' })]);
    expect(t.host.tasks).toEqual([]);
  });

  it('reports why the login ended without a session, and a drift of the selector map', async () => {
    const cases: [Error, string][] = [
      [
        new FlowError('INVALID_CREDENTIALS', 'X refused the user name or the password.'),
        'INVALID_CREDENTIALS',
      ],
      [new FlowError('INVALID_CODE', 'X refused the codes.'), 'INVALID_CODE'],
      [new FlowError('CHALLENGE_REQUIRED', 'X asks for a check.'), 'CHALLENGE_REQUIRED'],
      [new FlowError('TIMEOUT', 'No code came in time.'), 'TIMEOUT'],
      [new FlowError('RATE_LIMITED', 'Too many logins.'), 'TRANSIENT'],
      [new Error(`a message with ${PASSWORD}`), 'TRANSIENT'],
    ];
    for (const [error, failure] of cases) {
      const t = setup(() => Promise.reject(error));
      await t.runner.run(command());
      expect(t.reports).toEqual([expect.objectContaining({ kind: 'login.failed', failure })]);
      expect(t.lines.join('\n')).not.toContain(PASSWORD);
    }

    const drifted = setup(() => Promise.reject(drift('login.username')));
    await expect(drifted.runner.run(command())).resolves.toMatchObject({
      ok: false,
      error: { code: 'SELECTOR_DRIFT' },
    });
    expect(drifted.reports).toEqual([
      { kind: 'drift', flow: 'login', selector: 'login.username', selectorsVersion: 'x-v1' },
      expect.objectContaining({ kind: 'login.failed', failure: 'SELECTOR_DRIFT' }),
    ]);
  });

  it('closes the page when the time of the login runs out', async () => {
    const t = setup((page) => (page as unknown as FakePage).untilClosed(), {
      // 100 ms before the end of the login.
      now: () => new Date('2026-10-17T08:04:59.900Z'),
    });
    const login = command({ deadline: '2026-10-17T08:05:00.000Z' });

    await expect(t.runner.run(login)).resolves.toMatchObject({ ok: false });
    expect(t.reports).toEqual([expect.objectContaining({ kind: 'login.failed', failure: 'TIMEOUT' })]);
  });
});

describe('codeInbox', () => {
  it('pops the next code on a connection of its own and gives up at the end of the login', async () => {
    const calls: { key: string; seconds: number }[] = [];
    let disconnected = 0;
    const redis = {
      duplicate: () => ({
        blpop: (key: string, seconds: number) => {
          calls.push({ key, seconds });
          return Promise.resolve([key, Buffer.from('sealed-code').toString('base64')]);
        },
        disconnect: () => {
          disconnected += 1;
        },
      }),
    } as unknown as Pick<Redis, 'duplicate'>;
    const inbox = codeInbox(redis, () => NOW);
    const loginSessionId = randomUUID();

    const code = await inbox(loginSessionId, new Date('2026-10-17T08:04:30Z'));
    expect(Buffer.from(code ?? []).toString()).toBe('sealed-code');
    expect(calls).toEqual([{ key: XB_KEYS.loginInput(loginSessionId), seconds: 270 }]);
    expect(disconnected).toBe(1);
    await expect(inbox(loginSessionId, NOW)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });
});
