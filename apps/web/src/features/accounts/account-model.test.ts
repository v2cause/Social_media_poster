import { describe, expect, it } from 'vitest';

import { accessExpiryOf, initialsOf, preselectedAccounts, usdOf } from './account-model';

const now = new Date('2026-10-17T12:00:00Z');

const account = (externalId: string, connected: boolean) => ({
  externalId,
  type: 'PAGE' as const,
  name: externalId,
  handle: null,
  avatarUrl: null,
  connected,
});

describe('accounts page', () => {
  it('counts the days of an access that ends within two weeks and names the date of a later one', () => {
    expect(accessExpiryOf(null, now)).toEqual({ kind: 'never' });
    expect(accessExpiryOf('2026-10-17T11:59:59Z', now)).toEqual({ kind: 'expired' });
    expect(accessExpiryOf('2026-10-17T18:00:00Z', now)).toEqual({ kind: 'days', days: 0 });
    expect(accessExpiryOf('2026-10-22T13:00:00Z', now)).toEqual({ kind: 'days', days: 5 });
    expect(accessExpiryOf('2026-12-16T12:00:00Z', now)).toEqual({
      kind: 'date',
      date: new Date('2026-12-16T12:00:00Z'),
    });
  });

  it('shows micro-USD in dollars and initials for an avatar', () => {
    expect(usdOf(12_500)).toBe(0.0125);
    expect(initialsOf('Mira Becker')).toBe('MB');
    expect(initialsOf('  acme  gmbh & co ')).toBe('AC');
    expect(initialsOf('nordlicht')).toBe('N');
    expect(initialsOf('')).toBe('');
  });

  it('ticks the connected accounts on a reconnect and a single account on offer', () => {
    const accounts = [account('person', true), account('page-1', false), account('page-2', true)];
    expect(preselectedAccounts({ accounts, reconnectAccountId: 'some-account' })).toEqual(
      new Set(['person', 'page-2']),
    );
    expect(preselectedAccounts({ accounts, reconnectAccountId: null })).toEqual(new Set());
    expect(preselectedAccounts({ accounts: [account('person', false)], reconnectAccountId: null })).toEqual(
      new Set(['person']),
    );
  });
});
