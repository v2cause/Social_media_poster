import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ENVELOPE_VERSION, keyIdOf, open, rewrap, seal, SealedSecretError } from './envelope';
import { LocalKeyring } from './local-keyring';

// Guide step 4.2, "Fertig, wenn": a tampered byte fails, a wrong AAD fails, and a rotation reads
// with the old key and writes with the new one.

const kek1 = randomBytes(32);
const kek2 = randomBytes(32);
const keyring = (active: string, keys: Record<string, Buffer>): LocalKeyring =>
  new LocalKeyring(new Map(Object.entries(keys)), active);

const AAD = 'ws-1:conn-1:access_token';
const SECRET = 'access-token-1234567890';
const plaintext = Buffer.from(SECRET, 'utf8');
const TAIL = 12 + 16 + plaintext.length;

/** The error code a failed open ends with. */
async function failure(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (failed: unknown) => failed,
  );
  expect(error).toBeInstanceOf(SealedSecretError);
  return (error as SealedSecretError).code;
}

const ivOf = (sealed: Buffer): Buffer => {
  const keyIdLength = sealed[1] ?? 0;
  const offset = 2 + keyIdLength + 2 + sealed.readUInt16BE(2 + keyIdLength);
  return sealed.subarray(offset, offset + 12);
};

describe('envelope encryption', () => {
  it('opens what it sealed and lays the envelope out as documented', async () => {
    const kms = keyring('kek-1', { 'kek-1': kek1 });
    const sealed = await seal(plaintext, AAD, kms);

    expect((await open(sealed, AAD, kms)).toString('utf8')).toBe(SECRET);
    expect(sealed[0]).toBe(ENVELOPE_VERSION);
    expect(sealed[1]).toBe('kek-1'.length);
    expect(sealed.subarray(2, 7).toString('utf8')).toBe('kek-1');
    const wrappedLength = sealed.readUInt16BE(7);
    expect(wrappedLength).toBe(12 + 16 + 32);
    expect(sealed).toHaveLength(2 + 5 + 2 + wrappedLength + 12 + 16 + plaintext.length);
    expect(keyIdOf(sealed)).toBe('kek-1');
    expect(sealed.includes(plaintext)).toBe(false);
  });

  it('uses a fresh data key and IV for every secret', async () => {
    const kms = keyring('kek-1', { 'kek-1': kek1 });
    const [first, second] = await Promise.all([seal(plaintext, AAD, kms), seal(plaintext, AAD, kms)]);

    expect(first.equals(second)).toBe(false);
    expect(ivOf(first).equals(ivOf(second))).toBe(false);
  });

  it('seals empty and non-ASCII secrets', async () => {
    const kms = keyring('kek-1', { 'kek-1': kek1 });
    for (const text of ['', 'Grüße aus Köln, 東京 und Zürich']) {
      const sealed = await seal(Buffer.from(text, 'utf8'), AAD, kms);
      expect((await open(sealed, AAD, kms)).toString('utf8')).toBe(text);
    }
  });

  it('refuses an envelope with any single byte changed, cut or extended', async () => {
    const kms = keyring('kek-1', { 'kek-1': kek1 });
    const sealed = await seal(plaintext, AAD, kms);

    for (let index = 0; index < sealed.length; index += 1) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(['MALFORMED', 'UNKNOWN_KEY', 'INVALID'], `byte ${String(index)}`).toContain(
        await failure(open(tampered, AAD, kms)),
      );
    }
    await expect(failure(open(sealed.subarray(0, sealed.length - 1), AAD, kms))).resolves.toBe('INVALID');
    await expect(failure(open(Buffer.concat([sealed, Buffer.from([0])]), AAD, kms))).resolves.toBe('INVALID');
    await expect(failure(open(sealed.subarray(0, 20), AAD, kms))).resolves.toBe('MALFORMED');
    await expect(failure(open(Buffer.alloc(0), AAD, kms))).resolves.toBe('MALFORMED');
  });

  it('refuses a data key of another envelope, even under the same KEK', async () => {
    const kms = keyring('kek-1', { 'kek-1': kek1 });
    const first = await seal(plaintext, AAD, kms);
    const second = await seal(plaintext, AAD, kms);
    const keyEnd = 2 + 5 + 2 + 60;
    const swapped = Buffer.concat([second.subarray(0, keyEnd), first.subarray(keyEnd)]);

    await expect(failure(open(swapped, AAD, kms))).resolves.toBe('INVALID');
  });

  it('refuses a wrong AAD, so an envelope does not open in another row or field', async () => {
    const kms = keyring('kek-1', { 'kek-1': kek1 });
    const sealed = await seal(plaintext, AAD, kms);

    for (const aad of [
      'ws-1:conn-2:access_token',
      'ws-1:conn-1:refresh_token',
      'ws-2:conn-1:access_token',
      '',
    ]) {
      await expect(failure(open(sealed, aad, kms)), aad).resolves.toBe('INVALID');
    }
  });

  it('keeps keys and plaintext out of its errors', async () => {
    const kms = keyring('kek-1', { 'kek-1': kek1 });
    const sealed = await seal(plaintext, AAD, kms);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;

    for (const attempt of [open(tampered, AAD, kms), open(sealed, 'other', kms)]) {
      const error = (await attempt.catch((failed: unknown) => failed)) as Error;
      const text = `${error.message}\n${String(error.stack)}`;
      for (const secret of [SECRET, kek1.toString('base64'), kek1.toString('hex')]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('rotates: opens with the old key, seals with the new one and re-wraps the rest', async () => {
    const before = keyring('kek-1', { 'kek-1': kek1 });
    const sealedBefore = await seal(plaintext, AAD, before);
    const rotated = keyring('kek-2', { 'kek-1': kek1, 'kek-2': kek2 });

    expect((await open(sealedBefore, AAD, rotated)).toString('utf8')).toBe(SECRET);
    expect(keyIdOf(await seal(plaintext, AAD, rotated))).toBe('kek-2');

    const rewrapped = await rewrap(sealedBefore, rotated);
    if (!rewrapped) {
      throw new Error('expected a re-wrapped envelope');
    }
    expect(keyIdOf(rewrapped)).toBe('kek-2');
    // Only the wrapped data key changed; IV, tag and ciphertext are the same bytes.
    expect(rewrapped.subarray(-TAIL).equals(sealedBefore.subarray(-TAIL))).toBe(true);
    await expect(rewrap(rewrapped, rotated)).resolves.toBeNull();

    const after = keyring('kek-2', { 'kek-2': kek2 });
    expect((await open(rewrapped, AAD, after)).toString('utf8')).toBe(SECRET);
    await expect(failure(open(sealedBefore, AAD, after))).resolves.toBe('UNKNOWN_KEY');
    await expect(failure(rewrap(sealedBefore, after))).resolves.toBe('UNKNOWN_KEY');
  });
});
