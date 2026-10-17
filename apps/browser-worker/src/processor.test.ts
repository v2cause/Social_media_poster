import { randomUUID } from 'node:crypto';

import type { XbCommand, XbOutcome } from '@smp/x-browser';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { Postponed, type AccountOperation } from './command-runner';
import { processCommand, type CommandHandlers } from './processor';

// Guide step 6.2: the job name picks the operation, a command that does not parse fails without
// a retry, and a busy account postpones the job without using an attempt.

const NOW = new Date('2026-10-17T08:00:00Z');
const target = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  accountId: randomUUID(),
  externalUserId: '1234567890',
  handle: 'smp_demo',
  locale: 'de',
  session: Buffer.from('sealed').toString('base64'),
};
const verify = { commandId: randomUUID(), deadline: '2026-10-17T08:05:00.000Z', target };

const job = (name: string, data: unknown) => {
  const delays: { until: number; token: string }[] = [];
  return {
    name,
    data,
    delays,
    moveToDelayed: (until: number, token?: string) => {
      delays.push({ until, token: token ?? '' });
      return Promise.resolve();
    },
  };
};

const handlers = (run: CommandHandlers['run']): CommandHandlers => ({
  run,
  login: () => Promise.resolve({ ok: false, error: { code: 'UNAVAILABLE', message: 'no login' } }),
});

describe('processCommand', () => {
  it('runs the operation of the job name and returns its outcome', async () => {
    const seen: string[] = [];
    const outcome = {
      ok: true as const,
      data: { user: { id: '1', handle: 'a', name: 'A', avatarUrl: null } },
    };
    const run = <O extends AccountOperation>(operation: O, command: XbCommand<O>) => {
      seen.push(`${operation}:${command.commandId}`);
      return Promise.resolve(outcome as XbOutcome<O>);
    };
    await expect(
      processCommand(job('xb.verify-session', verify), 'token', handlers(run), () => NOW),
    ).resolves.toBe(outcome);
    expect(seen).toEqual([`verify-session:${verify.commandId}`]);
  });

  it('fails an unknown or broken command at once', async () => {
    const run = () => Promise.reject(new Error('not expected'));
    await expect(
      processCommand(job('xb.unknown', verify), 'token', handlers(run), () => NOW),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    const broken = processCommand(
      job('xb.verify-session', { ...verify, target: { ...target, session: 'not base64!' } }),
      'token',
      handlers(run),
      () => NOW,
    );
    await expect(broken).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(broken).rejects.toThrow('The command xb.verify-session does not parse.');
  });

  it('postpones a busy account as a delayed job', async () => {
    const busy = job('xb.verify-session', verify);
    const run = () => Promise.reject(new Postponed(90_000, 'spacing'));
    await expect(processCommand(busy, 'lock-token', handlers(run), () => NOW)).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(busy.delays).toEqual([{ until: NOW.getTime() + 90_000, token: 'lock-token' }]);
  });

  it('hands the login to its own runner', async () => {
    const login = {
      commandId: randomUUID(),
      deadline: '2026-10-17T08:05:00.000Z',
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      loginSessionId: randomUUID(),
      locale: 'en',
      credentials: Buffer.from('sealed').toString('base64'),
    };
    const run = () => Promise.reject(new Error('not expected'));
    await expect(
      processCommand(job('xb.login.start', login), 'token', handlers(run), () => NOW),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'UNAVAILABLE', message: 'no login' },
    });
  });
});
