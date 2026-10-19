import { describe, expect, it } from 'vitest';

import { twoFactorResetRequestOf } from './reset-two-factor';

describe('twoFactorResetRequestOf', () => {
  it('takes the address, the reference of the support case and whether to check only', () => {
    expect(twoFactorResetRequestOf(['--user', 'ada@example.test', '--ticket', 'SUP-1024'])).toEqual({
      email: 'ada@example.test',
      ticket: 'SUP-1024',
      check: false,
    });
    expect(
      twoFactorResetRequestOf(['--check', '--user', 'ada@example.test', '--ticket', 'SUP-1024']),
    ).toEqual({
      email: 'ada@example.test',
      ticket: 'SUP-1024',
      check: true,
    });
  });

  it('refuses a call without ticket, with another option or with a ticket of odd shape', () => {
    expect(twoFactorResetRequestOf(['--user', 'ada@example.test'])).toBeNull();
    expect(twoFactorResetRequestOf(['--ticket', 'SUP-1'])).toBeNull();
    expect(twoFactorResetRequestOf(['--user', 'ada@example.test', '--ticket', 'SUP-1', '--all'])).toBeNull();
    expect(twoFactorResetRequestOf(['--user', 'not an address', '--ticket', 'SUP-1'])).toBeNull();
    expect(twoFactorResetRequestOf(['--user', 'ada@example.test', '--ticket', 'see\nnext line'])).toBeNull();
  });
});
