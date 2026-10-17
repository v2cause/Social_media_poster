import { randomUUID } from 'node:crypto';

import { createLogger } from '@smp/observability';
import { drift, FlowError, xbSessionAad, type XbCommand, type XbReport } from '@smp/x-browser';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import type { GuardResult } from './account-guard';
import type { StorageState, TaskEnd, TaskOptions } from './browser-host';
import {
  CommandRunner,
  Postponed,
  type AccountOperation,
  type SessionSealer,
  type XbFlows,
} from './command-runner';
import { MediaUnavailableError, type MediaFile } from './media';

// Guide step 6.2: the runner checks the kill switch, the deadline and the guard of the account
// before the browser starts, opens the session with the AAD of the connection, seals it again
// afterwards and reports drift; texts and sessions never reach the logs.

const NOW = new Date('2026-10-17T08:00:00Z');
const TEXT = 'A post that must never appear in a log line';
const before: StorageState = {
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
const after: StorageState = { ...before, origins: [{ origin: 'https://x.com', localStorage: [] }] };

const sealer: SessionSealer = {
  seal: (plaintext, aad) => Promise.resolve(Buffer.from(JSON.stringify({ plaintext, aad }))),
  open: (sealed, aad) => {
    const box = JSON.parse(Buffer.from(sealed).toString('utf8')) as { plaintext: string; aad: string };
    return box.aad === aad ? Promise.resolve(box.plaintext) : Promise.reject(new Error('wrong aad'));
  },
};

const sealedFor = (workspaceId: string, externalUserId: string): string =>
  Buffer.from(
    JSON.stringify({ plaintext: JSON.stringify(before), aad: xbSessionAad(workspaceId, externalUserId) }),
  ).toString('base64');

const workspaceId = randomUUID();
const target = {
  organizationId: randomUUID(),
  workspaceId,
  connectionId: randomUUID(),
  accountId: randomUUID(),
  externalUserId: '1234567890',
  handle: 'smp_demo',
  locale: 'de' as const,
  // The session of the target, sealed with the AAD of its workspace and X user.
  session: sealedFor(workspaceId, '1234567890'),
};

const command = (overrides: Partial<{ deadline: string }> = {}) => ({
  commandId: randomUUID(),
  deadline: overrides.deadline ?? '2026-10-17T08:05:00.000Z',
  target,
});
const publishCommand = (): XbCommand<'publish'> => ({
  ...command(),
  text: TEXT,
  media: [
    { url: 'http://s3:8333/smp-media/a.jpg?X-Amz-Signature=abc', mimeType: 'image/jpeg', altText: 'A cat' },
  ],
});

class FakeHost {
  readonly tasks: TaskOptions[] = [];
  constructor(
    private readonly state: StorageState | null = after,
    private readonly refusedHosts: string[] = [],
  ) {}

  async run<T>(task: TaskOptions, work: (page: Page) => Promise<T>): Promise<TaskEnd<T>> {
    this.tasks.push(task);
    try {
      return {
        result: { ok: true, value: await work({} as Page) },
        storageState: this.state,
        refusedHosts: this.refusedHosts,
      };
    } catch (error) {
      return { result: { ok: false, error }, storageState: this.state, refusedHosts: this.refusedHosts };
    }
  }
}

class FakeGuard {
  busy: GuardResult | null = null;
  readonly acquired: { accountId: string; token: string; post: boolean }[] = [];
  readonly spacedAccounts: string[] = [];
  released = 0;

  acquire(accountId: string, token: string, post: boolean): Promise<GuardResult> {
    if (this.busy) {
      return Promise.resolve(this.busy);
    }
    this.acquired.push({ accountId, token, post });
    return Promise.resolve({
      kind: 'acquired',
      release: () => {
        this.released += 1;
        return Promise.resolve();
      },
    });
  }

  spaced(accountId: string): Promise<void> {
    this.spacedAccounts.push(accountId);
    return Promise.resolve();
  }
}

const unexpected = (): Promise<never> => Promise.reject(new Error('flow not expected'));

function setup(options: { flows?: Partial<XbFlows>; host?: FakeHost; killed?: boolean } = {}) {
  const host = options.host ?? new FakeHost();
  const guard = new FakeGuard();
  const reports: XbReport[] = [];
  const lines: string[] = [];
  const downloads: string[] = [];
  const seenMedia: (readonly MediaFile[])[] = [];
  const flows: XbFlows = {
    selectorsVersion: 'x-v1',
    publish: unexpected,
    reconcile: unexpected,
    metrics: unexpected,
    'account-metrics': unexpected,
    delete: unexpected,
    'verify-session': unexpected,
    canary: unexpected,
    ...options.flows,
  };
  const runner = new CommandRunner({
    host,
    guard,
    sealer,
    flows: {
      ...flows,
      publish: (page, cmd, media) => {
        seenMedia.push(media);
        return flows.publish(page, cmd, media);
      },
    },
    media: (url) => {
      downloads.push(url);
      return url.includes('broken')
        ? Promise.reject(new MediaUnavailableError('status'))
        : Promise.resolve(Buffer.from('jpeg-bytes'));
    },
    report: (report) => {
      reports.push(report);
      return Promise.resolve();
    },
    killed: () => Promise.resolve(options.killed ?? false),
    now: () => NOW,
    logger: createLogger({
      service: 'browser-worker',
      environment: 'test',
      destination: { write: (line: string) => lines.push(line) },
    }),
  });
  return { runner, host, guard, reports, lines, downloads, seenMedia };
}

const run = <O extends AccountOperation>(runner: CommandRunner, operation: O, cmd: unknown) =>
  runner.run(operation, cmd as XbCommand<O>);

describe('CommandRunner', () => {
  it('posts with the opened session and the media, then seals the new session and spaces the account', async () => {
    const posted = {
      externalPostId: '1846000000000000001',
      externalUrl: 'https://x.com/smp_demo/status/1846000000000000001',
      publishedAt: NOW.toISOString(),
    };
    const { runner, host, guard, reports, lines, seenMedia } = setup({
      flows: { publish: () => Promise.resolve(posted) },
    });
    const cmd = publishCommand();

    await expect(runner.run('publish', cmd)).resolves.toEqual({ ok: true, data: posted });
    expect(host.tasks).toEqual([{ storageState: before, locale: 'de' }]);
    expect(seenMedia).toEqual([
      [{ name: 'image-1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpeg-bytes'), altText: 'A cat' }],
    ]);
    expect(guard.acquired).toEqual([{ accountId: target.accountId, token: cmd.commandId, post: true }]);
    expect(guard.released).toBe(1);
    expect(guard.spacedAccounts).toEqual([target.accountId]);

    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report).toMatchObject({
      kind: 'session.updated',
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      externalUserId: target.externalUserId,
    });
    const sealed = report?.kind === 'session.updated' ? report.session : '';
    await expect(
      sealer.open(Buffer.from(sealed, 'base64'), xbSessionAad(target.workspaceId, target.externalUserId)),
    ).resolves.toBe(JSON.stringify(after));

    const log = lines.join('');
    expect(log).toContain('xb.command.finished');
    expect(log).not.toContain(TEXT);
    expect(log).not.toContain('secret-cookie-value');
    expect(log).not.toContain('X-Amz-Signature');
  });

  it('refuses every command while the kill switch is on and after the deadline', async () => {
    const off = setup({ killed: true });
    await expect(run(off.runner, 'verify-session', command())).resolves.toEqual({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'The X browser is switched off.' },
    });
    expect(off.guard.acquired).toEqual([]);

    const late = setup();
    await expect(
      run(late.runner, 'verify-session', command({ deadline: '2026-10-17T07:59:59.000Z' })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'EXPIRED' } });
    expect(late.host.tasks).toEqual([]);
  });

  it('postpones a command while the account is busy or still spaced', async () => {
    const { runner, guard, host } = setup();
    guard.busy = { kind: 'busy', reason: 'spacing', waitMs: 90_000 };
    const postponed = runner.run('publish', publishCommand());
    await expect(postponed).rejects.toBeInstanceOf(Postponed);
    await expect(postponed).rejects.toMatchObject({ waitMs: 90_000, reason: 'spacing' });
    expect(host.tasks).toEqual([]);
  });

  it('reports a drift with the selector and keeps the session', async () => {
    const { runner, reports } = setup({ flows: { publish: () => Promise.reject(drift('composer.submit')) } });
    await expect(runner.run('publish', publishCommand())).resolves.toEqual({
      ok: false,
      error: { code: 'SELECTOR_DRIFT', message: 'The selector composer.submit no longer matches.' },
    });
    expect(reports.map((report) => report.kind)).toEqual(['drift', 'session.updated']);
    expect(reports[0]).toEqual({
      kind: 'drift',
      flow: 'publish',
      selector: 'composer.submit',
      selectorsVersion: 'x-v1',
    });
  });

  it('drops the session after a challenge and reads a lost login as an expired session', async () => {
    const challenged = setup({
      flows: { metrics: () => Promise.reject(new FlowError('CHALLENGE_REQUIRED', 'X asks for a check.')) },
    });
    await expect(
      run(challenged.runner, 'metrics', { ...command(), externalPostIds: ['1846000000000000001'] }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'CHALLENGE_REQUIRED' } });
    expect(challenged.reports).toEqual([]);

    const signedOut = setup({
      flows: {
        'verify-session': () => Promise.reject(new FlowError('INVALID_CREDENTIALS', 'Signed out.')),
      },
    });
    await expect(run(signedOut.runner, 'verify-session', command())).resolves.toMatchObject({
      ok: false,
      error: { code: 'AUTH_EXPIRED' },
    });
    expect(signedOut.reports).toEqual([]);
  });

  it('passes the wait of a rate limit on', async () => {
    const { runner } = setup({
      flows: {
        delete: () =>
          Promise.reject(new FlowError('RATE_LIMITED', 'Too many requests.', { retryAfterMs: 900_000 })),
      },
    });
    await expect(
      run(runner, 'delete', { ...command(), externalPostId: '1846000000000000001' }),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests.', retryAfterMs: 900_000 },
    });
  });

  it('reads an unnamed failure as unknown for a post and as transient for a read', async () => {
    const posting = setup({ flows: { publish: () => Promise.reject(new TypeError('page crashed')) } });
    await expect(posting.runner.run('publish', publishCommand())).resolves.toMatchObject({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    expect(posting.guard.spacedAccounts).toEqual([target.accountId]);
    expect(posting.lines.join('')).not.toContain('page crashed');

    const reading = setup({
      flows: { 'account-metrics': () => Promise.reject(new TypeError('page crashed')) },
    });
    await expect(run(reading.runner, 'account-metrics', command())).resolves.toMatchObject({
      ok: false,
      error: { code: 'TRANSIENT' },
    });
  });

  it('fails before the browser when the session does not open or the media do not load', async () => {
    const foreign = setup();
    const otherWorkspace = sealedFor(randomUUID(), target.externalUserId);
    await expect(
      run(foreign.runner, 'verify-session', { ...command(), target: { ...target, session: otherWorkspace } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'AUTH_EXPIRED' } });
    expect(foreign.host.tasks).toEqual([]);

    const broken = setup();
    const cmd = publishCommand();
    await expect(
      broken.runner.run('publish', {
        ...cmd,
        media: [{ url: 'http://s3:8333/smp-media/broken.jpg', mimeType: 'image/jpeg', altText: null }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'TRANSIENT' } });
    expect(broken.host.tasks).toEqual([]);
    expect(broken.guard.spacedAccounts).toEqual([]);
    expect(broken.guard.released).toBe(1);
  });

  it('keeps an unchanged session to itself and reports the hosts the browser refused', async () => {
    const user = { id: '1234567890', handle: 'smp_demo', name: 'Demo', avatarUrl: null };
    const { runner, reports, lines } = setup({
      host: new FakeHost(before, ['tracker.example']),
      flows: { 'verify-session': () => Promise.resolve({ user }) },
    });
    await expect(run(runner, 'verify-session', command())).resolves.toEqual({ ok: true, data: { user } });
    expect(reports).toEqual([]);
    expect(lines.join('')).toContain('"refusedHosts":["tracker.example"]');
  });

  it('reports the canary with the missing selectors', async () => {
    const { runner, reports } = setup({
      host: new FakeHost(before),
      flows: { canary: () => Promise.resolve({ missing: ['composer.textbox'] }) },
    });
    await expect(run(runner, 'canary', command())).resolves.toEqual({
      ok: true,
      data: { missing: ['composer.textbox'] },
    });
    expect(reports).toEqual([
      { kind: 'canary', ok: false, missing: ['composer.textbox'], selectorsVersion: 'x-v1' },
    ]);
  });
});
