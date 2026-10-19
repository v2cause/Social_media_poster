import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SealedSecretError } from './envelope';
import { EnvelopeSealer, notifySealerFromEnv, sealerFromEnv } from './envelope-sealer';
import { KeyringConfigError, LocalKeyring } from './local-keyring';

// The keyring of the env (TOKEN_KEKS, SESSION_KEKS in the format of pnpm gen:keys) and the
// wrapping of data keys.

const NAMES = { keys: 'TOKEN_KEKS', active: 'TOKEN_KEK_ACTIVE' };
const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');

const configError = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KeyringConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a KeyringConfigError');
};

describe('LocalKeyring', () => {
  it('reads the keys of pnpm gen:keys, several for a rotation', () => {
    const keyring = LocalKeyring.fromEnv(NAMES, ` kek-a:${keyA} , kek-b:${keyB} `, 'kek-b');

    expect(keyring.keyIds).toEqual(['kek-a', 'kek-b']);
    expect(keyring.activeKeyId).toBe('kek-b');
  });

  it('refuses unusable keyrings and never names a key in its messages', () => {
    const cases: [string | undefined, string | undefined, RegExp][] = [
      [undefined, 'kek-a', /TOKEN_KEKS is empty; generate keys with pnpm gen:keys/],
      [`kek-a:${keyA}`, 'kek-x', /TOKEN_KEK_ACTIVE must name a key id of TOKEN_KEKS/],
      [`kek-a:${keyA},kek-a:${keyB}`, 'kek-a', /key id kek-a appears twice/],
      [keyA, 'kek-a', /entry 1 must be/],
      [`kek a:${keyA}`, 'kek-a', /entry 1 must be/],
      [`kek-a:${keyA},kek-b:${randomBytes(16).toString('base64')}`, 'kek-a', /entry 2 must be/],
      [`kek-a:${randomBytes(32).toString('base64url')}x`, 'kek-a', /entry 1 must be/],
    ];
    for (const [keys, active, message] of cases) {
      const text = configError(() => LocalKeyring.fromEnv(NAMES, keys, active));
      expect(text).toMatch(message);
      expect(text).not.toContain(keyA);
      expect(text).not.toContain(keyB);
    }
  });

  it('binds a wrapped data key to its key id and notices tampering', async () => {
    const shared = randomBytes(32);
    const keyring = new LocalKeyring(
      new Map([
        ['kek-a', shared],
        ['kek-b', shared],
      ]),
      'kek-a',
    );
    const dataKey = randomBytes(32);
    const { keyId, wrappedKey } = await keyring.wrapKey(dataKey);

    expect(keyId).toBe('kek-a');
    expect(Buffer.from(await keyring.unwrapKey('kek-a', wrappedKey)).equals(dataKey)).toBe(true);
    await expect(keyring.unwrapKey('kek-b', wrappedKey)).rejects.toMatchObject({ code: 'INVALID' });
    await expect(keyring.unwrapKey('kek-x', wrappedKey)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    const tampered = Buffer.from(wrappedKey);
    tampered[20] = (tampered[20] ?? 0) ^ 0x01;
    await expect(keyring.unwrapKey('kek-a', tampered)).rejects.toBeInstanceOf(SealedSecretError);
    await expect(keyring.unwrapKey('kek-a', Buffer.alloc(10))).rejects.toMatchObject({ code: 'INVALID' });
  });
});

describe('EnvelopeSealer', () => {
  it('seals strings with the keyring of the env and re-wraps after a rotation', async () => {
    const before = sealerFromEnv('tokens', { TOKEN_KEKS: `kek-a:${keyA}`, TOKEN_KEK_ACTIVE: 'kek-a' });
    const sealed = await before.seal('refresh-token', 'ws:conn:refresh_token');
    const after = new EnvelopeSealer(LocalKeyring.fromEnv(NAMES, `kek-a:${keyA},kek-b:${keyB}`, 'kek-b'));

    await expect(after.open(sealed, 'ws:conn:refresh_token')).resolves.toBe('refresh-token');
    const rewrapped = await after.rewrap(sealed);
    expect(rewrapped).not.toBeNull();
    await expect(after.rewrap(rewrapped ?? sealed)).resolves.toBeNull();
    expect(() => sealerFromEnv('sessions', { TOKEN_KEKS: `kek-a:${keyA}` })).toThrow(/SESSION_KEKS is empty/);
  });
});

describe('the keyring of the e-mail jobs', () => {
  const tokens = { TOKEN_KEKS: `kek-a:${keyA}`, TOKEN_KEK_ACTIVE: 'kek-a' };

  it('seals with NOTIFY_KEKS, which the token keyring cannot open', async () => {
    const notify = notifySealerFromEnv({
      ...tokens,
      NOTIFY_KEKS: `ntf-1:${keyB}`,
      NOTIFY_KEK_ACTIVE: 'ntf-1',
    });

    const sealed = await notify.seal('{"to":"a@example.com"}', 'notify.email');

    await expect(notify.open(sealed, 'notify.email')).resolves.toBe('{"to":"a@example.com"}');
    await expect(sealerFromEnv('tokens', tokens).open(sealed, 'notify.email')).rejects.toMatchObject({
      code: 'UNKNOWN_KEY',
    });
  });

  it('falls back to the token keyring without NOTIFY_KEKS, as in development', async () => {
    const sealed = await notifySealerFromEnv({ ...tokens, NOTIFY_KEKS: '' }).seal('mail', 'notify.email');

    await expect(sealerFromEnv('tokens', tokens).open(sealed, 'notify.email')).resolves.toBe('mail');
  });

  it('requires NOTIFY_KEKS in production', () => {
    expect(configError(() => notifySealerFromEnv({ ...tokens, NODE_ENV: 'production' }))).toBe(
      'NOTIFY_KEKS is required in production; generate keys with pnpm gen:keys.',
    );
  });

  it('names NOTIFY_KEK_ACTIVE when it does not fit NOTIFY_KEKS', () => {
    expect(configError(() => notifySealerFromEnv({ ...tokens, NOTIFY_KEKS: `ntf-1:${keyB}` }))).toBe(
      'NOTIFY_KEK_ACTIVE must name a key id of NOTIFY_KEKS.',
    );
  });
});
