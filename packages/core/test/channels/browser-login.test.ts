import { describe, expect, it } from 'vitest';

import {
  BrowserLoginNotAwaitingCodeError,
  BrowserLoginNotFoundError,
  CompleteBrowserLogin,
  GetBrowserLogin,
  NotPermittedError,
  RecordBrowserLoginStep,
  SocialAccountNotFoundError,
  StartBrowserLogin,
  SubmitBrowserLoginCode,
  TooManyBrowserLoginsError,
  XBrowserUnavailableError,
  type BrowserLoginDependencies,
  type BrowserLoginStep,
  type ContentActor,
  type SocialAccount,
} from '../../src';
import { MemoryBrowserLogins, RecordingLoginEvents, RecordingLoginQueue } from '../in-memory-browser-login';
import { fakeSealer, InMemoryChannels, MemoryAccountLimits } from '../in-memory-channels';
import { sequentialIds } from '../in-memory-content';

// Guide step 6.4: the interactive login of X. The credentials reach the browser worker sealed
// and nowhere else, a code goes on only while X asks for one, the login ends after five minutes,
// and a successful login stores the browser connection with its session and account.

const owner: ContentActor = {
  userId: 'user-owner',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  role: 'OWNER',
};
const admin: ContentActor = { ...owner, userId: 'user-admin', role: 'ADMIN' };
const editor: ContentActor = { ...owner, userId: 'user-editor', role: 'EDITOR' };

const aad = (workspaceId: string, loginSessionId: string, field: 'credentials' | 'code'): string =>
  `${workspaceId}:xb-login.${loginSessionId}:${field}`;
const demoUser = { id: '1234567890', handle: 'smp_demo', name: 'SMP Demo', avatarUrl: null };
const text = (bytes: Uint8Array | null | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

const only = <T>(items: readonly T[]): T => {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error(`expected one item, got ${String(items.length)}`);
  }
  return item;
};

const account = (overrides: Partial<SocialAccount> = {}): SocialAccount => ({
  id: 'acc-x',
  workspaceId: 'ws-1',
  connectionId: 'conn-api',
  platform: 'X',
  type: 'PROFILE',
  externalId: '1234567890',
  name: 'SMP Demo',
  handle: 'smp_demo',
  avatarUrl: null,
  accessTokenSealed: null,
  disconnectedAt: null,
  version: 0,
  ...overrides,
});

function setup(options: { open?: boolean } = {}) {
  let now = new Date('2026-10-17T08:00:00Z');
  const logins = new MemoryBrowserLogins();
  const queue = new RecordingLoginQueue();
  const events = new RecordingLoginEvents();
  const channels = new InMemoryChannels();
  const accounts = new MemoryAccountLimits(channels);
  const deps: BrowserLoginDependencies = {
    logins,
    queue,
    events,
    sealer: fakeSealer,
    aad,
    gate: { allows: () => Promise.resolve(options.open ?? true) },
    accounts,
    unitOfWork: channels,
    clock: { now: () => now },
    ids: sequentialIds('xbl'),
  };
  const scope = { organizationId: 'org-1', workspaceId: 'ws-1' };
  return {
    deps,
    logins,
    queue,
    events,
    channels,
    accounts,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    start: (actor = owner, reconnectAccountId: string | null = null) =>
      new StartBrowserLogin(deps).execute({
        actor,
        username: 'smp_demo',
        password: 'secret-password',
        locale: 'en',
        reconnectAccountId,
      }),
    submit: (loginId: string, code: string, actor = owner) =>
      new SubmitBrowserLoginCode(deps).execute({ actor, loginId, code }),
    get: (loginId: string, actor = owner) => new GetBrowserLogin(deps).execute(actor, loginId),
    report: (loginSessionId: string, step: BrowserLoginStep) =>
      new RecordBrowserLoginStep(deps).execute({ ...scope, loginSessionId, step }),
    complete: (loginSessionId: string, user = demoUser, session = 'sealed-session') =>
      new CompleteBrowserLogin(deps).execute({
        ...scope,
        loginSessionId,
        user,
        sessionSealed: new TextEncoder().encode(session),
      }),
  };
}

describe('the interactive login of X', () => {
  it('seals the credentials for the browser worker alone and keeps nothing of them', async () => {
    const t = setup();
    const login = await t.start();

    expect(login).toMatchObject({
      status: 'STARTING',
      failure: null,
      accountId: null,
      userId: 'user-owner',
      workspaceId: 'ws-1',
      locale: 'en',
      expiresAt: new Date('2026-10-17T08:05:00Z'),
    });
    const command = only(t.queue.commands);
    expect(command).toMatchObject({
      loginSessionId: login.id,
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      locale: 'en',
      deadline: new Date('2026-10-17T08:02:00Z'),
      expiresAt: new Date('2026-10-17T08:05:00Z'),
    });
    expect(
      JSON.parse(await fakeSealer.open(command.credentialsSealed, aad('ws-1', login.id, 'credentials'))),
    ).toEqual({ username: 'smp_demo', password: 'secret-password' });
    await expect(fakeSealer.open(command.credentialsSealed, aad('ws-1', login.id, 'code'))).rejects.toThrow();
    expect(JSON.stringify([...t.logins.logins.values()])).not.toContain('secret-password');
  });

  it('refuses a start without the role, with the X browser closed, for another account and beyond five an hour', async () => {
    await expect(setup().start(editor)).rejects.toBeInstanceOf(NotPermittedError);
    await expect(setup({ open: false }).start()).rejects.toBeInstanceOf(XBrowserUnavailableError);

    const t = setup();
    t.channels.state.accounts.set('acc-li', account({ id: 'acc-li', platform: 'LINKEDIN' }));
    t.channels.state.accounts.set('acc-gone', account({ id: 'acc-gone', disconnectedAt: new Date() }));
    for (const accountId of ['acc-li', 'acc-gone', 'acc-unknown']) {
      await expect(t.start(owner, accountId)).rejects.toBeInstanceOf(SocialAccountNotFoundError);
    }
    for (let started = 0; started < 5; started += 1) {
      await t.start(admin);
    }
    await expect(t.start()).rejects.toBeInstanceOf(TooManyBrowserLoginsError);
    expect(t.queue.commands).toHaveLength(5);

    // The next hour counts afresh.
    t.advance(60 * 60_000);
    await expect(t.start()).resolves.toMatchObject({ status: 'STARTING' });
  });

  it('starts a login for a new account only while the plan has room for it (guide step 7.4)', async () => {
    const t = setup();
    t.accounts.max = 0;

    await expect(t.start()).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
      params: { limit: 'maxSocialAccounts', max: 0 },
    });
    expect(t.queue.commands).toEqual([]);
  });

  it('passes a code on sealed only while X asks for one, and once per question', async () => {
    const t = setup();
    const login = await t.start();
    await expect(t.submit(login.id, '123456')).rejects.toBeInstanceOf(BrowserLoginNotAwaitingCodeError);

    await expect(t.report(login.id, { kind: 'awaiting_code' })).resolves.toBe(true);
    await expect(t.submit(login.id, '123456')).resolves.toMatchObject({ status: 'VERIFYING' });
    await expect(t.submit(login.id, '654321')).rejects.toBeInstanceOf(BrowserLoginNotAwaitingCodeError);
    const code = only(t.logins.codes.get(login.id) ?? []);
    await expect(fakeSealer.open(code, aad('ws-1', login.id, 'code'))).resolves.toBe('123456');

    // X did not take the code and asks again.
    await expect(t.report(login.id, { kind: 'awaiting_code' })).resolves.toBe(true);
    await expect(t.submit(login.id, '654321')).resolves.toMatchObject({ status: 'VERIFYING' });
    expect(t.logins.codes.get(login.id)).toHaveLength(2);
    expect(t.events.events).toEqual(
      ['AWAITING_2FA', 'VERIFYING', 'AWAITING_2FA', 'VERIFYING'].map((status) => ({
        id: login.id,
        userId: 'user-owner',
        status,
      })),
    );
  });

  it('shows a login to the user who started it only', async () => {
    const t = setup();
    const login = await t.start();

    await expect(t.get(login.id)).resolves.toMatchObject({ id: login.id, status: 'STARTING' });
    await expect(t.get(login.id, admin)).rejects.toBeInstanceOf(BrowserLoginNotFoundError);
    await expect(t.get(login.id, { ...owner, workspaceId: 'ws-2' })).rejects.toBeInstanceOf(
      BrowserLoginNotFoundError,
    );
    await expect(t.get('xbl-unknown')).rejects.toBeInstanceOf(BrowserLoginNotFoundError);
    await expect(t.submit(login.id, '123456', admin)).rejects.toBeInstanceOf(BrowserLoginNotFoundError);
    // A report has to name the organization and the workspace of the login.
    await expect(
      new RecordBrowserLoginStep(t.deps).execute({
        organizationId: 'org-2',
        workspaceId: 'ws-1',
        loginSessionId: login.id,
        step: { kind: 'awaiting_code' },
      }),
    ).resolves.toBe(false);
  });

  it('ends an open login after five minutes as TIMEOUT and ignores what comes later', async () => {
    const t = setup();
    const login = await t.start();
    await t.report(login.id, { kind: 'awaiting_code' });
    t.advance(5 * 60_000);

    await expect(t.get(login.id)).resolves.toMatchObject({ status: 'FAILED', failure: 'TIMEOUT' });
    await expect(t.submit(login.id, '123456')).rejects.toBeInstanceOf(BrowserLoginNotAwaitingCodeError);
    await expect(t.complete(login.id)).resolves.toEqual({ status: 'ignored' });
    expect(t.channels.state.connections.size).toBe(0);
    expect(t.events.events.map((event) => event.status)).toEqual(['AWAITING_2FA', 'FAILED']);
  });

  it('records a failure of the browser worker once', async () => {
    const t = setup();
    const login = await t.start();

    await expect(t.report(login.id, { kind: 'failed', failure: 'INVALID_CREDENTIALS' })).resolves.toBe(true);
    await expect(t.report(login.id, { kind: 'failed', failure: 'TRANSIENT' })).resolves.toBe(false);
    await expect(t.report(login.id, { kind: 'awaiting_code' })).resolves.toBe(false);
    await expect(t.get(login.id)).resolves.toMatchObject({
      status: 'FAILED',
      failure: 'INVALID_CREDENTIALS',
    });
    expect(t.events.events.map((event) => event.status)).toEqual(['FAILED']);
  });

  it('connects the X user with the session and the account, and renews both on the next login', async () => {
    const t = setup();
    const first = await t.start();
    const connected = await t.complete(first.id);
    if (connected.status !== 'connected') {
      throw new Error(`not connected: ${connected.status}`);
    }

    const connection = t.channels.state.connections.get(connected.connectionId);
    expect(connection).toMatchObject({
      platform: 'X',
      method: 'BROWSER',
      status: 'ACTIVE',
      externalUserId: '1234567890',
      displayName: 'SMP Demo',
      accessTokenSealed: null,
      refreshTokenSealed: null,
      scopes: [],
    });
    expect(text(connection?.sessionSealed)).toBe('sealed-session');
    expect(t.channels.state.accounts.get(connected.accountId)).toMatchObject({
      connectionId: connected.connectionId,
      platform: 'X',
      type: 'PROFILE',
      externalId: '1234567890',
      name: 'SMP Demo',
      handle: 'smp_demo',
    });
    expect(t.channels.state.accountSettings.get(connected.accountId)).toEqual({ locale: 'en' });
    expect(t.channels.state.audit).toEqual([
      expect.objectContaining({
        action: 'channel.connect',
        targetType: 'SocialConnection',
        targetId: connected.connectionId,
        metadata: { platform: 'X', method: 'BROWSER', accounts: 1 },
      }),
    ]);
    await expect(t.get(first.id)).resolves.toMatchObject({
      status: 'SUCCEEDED',
      accountId: connected.accountId,
    });
    expect(t.events.events.at(-1)).toMatchObject({ status: 'SUCCEEDED', userId: 'user-owner' });
    // A report that comes twice changes nothing.
    await expect(t.complete(first.id)).resolves.toEqual({ status: 'ignored' });

    const second = await t.start(owner, connected.accountId);
    await expect(t.complete(second.id, demoUser, 'sealed-session-2')).resolves.toEqual(connected);
    expect(t.channels.state.connections.size).toBe(1);
    expect(text(t.channels.state.connections.get(connected.connectionId)?.sessionSealed)).toBe(
      'sealed-session-2',
    );
    expect(t.channels.state.audit.map((entry) => entry.action)).toEqual([
      'channel.connect',
      'channel.reconnect',
    ]);
  });

  it('refuses another X user when an account is connected again', async () => {
    const t = setup();
    const connected = await t.complete((await t.start()).id);
    if (connected.status !== 'connected') {
      throw new Error(`not connected: ${connected.status}`);
    }
    const again = await t.start(owner, connected.accountId);

    await expect(t.complete(again.id, { ...demoUser, id: '999', handle: 'someone_else' })).resolves.toEqual({
      status: 'account_mismatch',
    });
    await expect(t.get(again.id)).resolves.toMatchObject({ status: 'FAILED', failure: 'ACCOUNT_MISMATCH' });
    expect(t.channels.state.connections.size).toBe(1);
    expect(t.channels.state.audit).toHaveLength(1);
  });
});
