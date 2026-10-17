import { randomUUID } from 'node:crypto';

import type { XBrowserCanaryAccount } from '@smp/db';
import { CommandNotAnsweredError, type XbCommandBus } from '@smp/platform-adapters';
import type { XbCommand } from '@smp/x-browser';
import { describe, expect, it } from 'vitest';

import { XBrowserCanaryTick } from './x-browser-canary';

// Guide step 6.5: the daily canary sends one command for the internal test account, with its
// sealed session and language, and logs what came back; without the account it sends nothing.

const NOW = new Date('2026-10-17T05:23:00Z');
const account: XBrowserCanaryAccount = {
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  accountId: randomUUID(),
  externalUserId: '1846000000000000777',
  handle: 'smp_canary',
  settings: { locale: 'en' },
  sessionSealed: Uint8Array.from([1, 2, 3]),
};

function setup(outcome: () => Promise<unknown>, found: XBrowserCanaryAccount | null = account) {
  const sent: { operation: string; command: XbCommand<'canary'>; waitMs: number }[] = [];
  const bus = {
    send: (operation: string, command: XbCommand<'canary'>, options: { waitMs: number }) => {
      sent.push({ operation, command, waitMs: options.waitMs });
      return outcome();
    },
  } as unknown as XbCommandBus;
  const tick = new XBrowserCanaryTick({
    accounts: { canaryAccount: (id) => Promise.resolve(id === account.accountId ? found : null) },
    bus,
    accountId: account.accountId,
    now: () => NOW,
    newId: () => '0192f5d4-0000-7000-8000-000000000001',
  });
  return { tick, sent };
}

describe('XBrowserCanaryTick', () => {
  it('runs the canary with the session and the language of the test account', async () => {
    const t = setup(() => Promise.resolve({ ok: true, data: { missing: ['nav.profile'] } }));

    await expect(t.tick.run()).resolves.toEqual({ canary: 'checked', missing: 1 });
    expect(t.sent).toEqual([
      {
        operation: 'canary',
        waitMs: 4 * 60_000,
        command: {
          commandId: '0192f5d4-0000-7000-8000-000000000001',
          deadline: '2026-10-17T05:25:00.000Z',
          target: {
            organizationId: account.organizationId,
            workspaceId: account.workspaceId,
            connectionId: account.connectionId,
            accountId: account.accountId,
            externalUserId: '1846000000000000777',
            handle: 'smp_canary',
            locale: 'en',
            session: Buffer.from([1, 2, 3]).toString('base64'),
          },
        },
      },
    ]);
  });

  it('sends nothing without the account and logs a refusal or a missing answer', async () => {
    const none = setup(() => Promise.reject(new Error('not expected')), null);
    await expect(none.tick.run()).resolves.toEqual({ canary: 'no_account' });
    expect(none.sent).toEqual([]);

    const killed = setup(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'UNAVAILABLE', message: 'The X browser is switched off.' },
      }),
    );
    await expect(killed.tick.run()).resolves.toEqual({ canary: 'failed', code: 'UNAVAILABLE' });

    const silent = setup(() => Promise.reject(new CommandNotAnsweredError('timeout')));
    await expect(silent.tick.run()).resolves.toEqual({ canary: 'unanswered', reason: 'timeout' });
  });
});
