import { randomBytes, scryptSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password-hash';

// Guide step 8.4 (ASVS 11.4.2): scrypt with the parameters of OWASP, older hashes still verify.

const PASSWORD = 'correct horse battery staple';

describe('password hashes', () => {
  it('hash with scrypt N=2^15, r=8, p=3 and a fresh salt each time', async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).toMatch(/^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{86}$/);
    expect(second).not.toBe(first);
    await expect(verifyPassword(first, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(first, 'correct horse battery stable')).resolves.toBe(false);
  });

  it('normalize the password, so that both forms of an umlaut match', async () => {
    const hash = await hashPassword('Mädchen im Garten 2026');

    await expect(verifyPassword(hash, 'Mädchen im Garten 2026')).resolves.toBe(true);
  });

  it('verify hashes in the format of Better Auth that the demo seed wrote before', async () => {
    const salt = randomBytes(16).toString('hex');
    const key = scryptSync(PASSWORD, salt, 64, { N: 16384, r: 16, p: 1, maxmem: 64 * 1024 * 1024 });
    const legacy = `${salt}:${key.toString('hex')}`;

    await expect(verifyPassword(legacy, PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(legacy, 'another passphrase')).resolves.toBe(false);
  });

  it('refuse damaged hashes and parameters out of reason without trying them', async () => {
    const valid = await hashPassword(PASSWORD);
    const [, , , , salt, key] = valid.split('$');

    for (const hash of [
      '',
      'scrypt$32768$8$3$',
      `scrypt$1073741824$8$1$${salt ?? ''}$${key ?? ''}`,
      `scrypt$32768$64$1$${salt ?? ''}$${key ?? ''}`,
      `scrypt$30000$8$3$${salt ?? ''}$${key ?? ''}`,
      'not-hex:also-not-hex',
      'a:b:c',
    ]) {
      await expect(verifyPassword(hash, PASSWORD)).resolves.toBe(false);
    }
  });
});
