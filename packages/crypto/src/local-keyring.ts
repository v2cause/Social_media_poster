import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { SealedSecretError } from './envelope';
import type { KmsPort, WrappedKey } from './kms';

// The KMS of a single deployment: the KEKs come from the env (TOKEN_KEKS, SESSION_KEKS) as
// "<key-id>:<base64 32-byte key>", comma-separated, and *_KEK_ACTIVE names the one that wraps new
// data keys. Older keys stay listed until the re-wrap job has moved every envelope to the active
// key. A wrapped data key is iv(12) | tag(16) | ciphertext, AES-256-GCM with the key id as AAD.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** A keyring that cannot be used. The message names the variable, never a key. */
export class KeyringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringConfigError';
  }
}

const keyIdAad = (keyId: string): Buffer => Buffer.from(`smp-kek:${keyId}`, 'utf8');

export class LocalKeyring implements KmsPort {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    keys: ReadonlyMap<string, Uint8Array>,
    readonly activeKeyId: string,
  ) {
    for (const [keyId, key] of keys) {
      if (!KEY_ID.test(keyId)) {
        throw new KeyringConfigError('A key id has 1 to 64 letters, digits, dots, dashes or underscores.');
      }
      if (key.length !== KEY_BYTES) {
        throw new KeyringConfigError(`Key ${keyId} must have ${String(KEY_BYTES)} bytes.`);
      }
    }
    if (!keys.has(activeKeyId)) {
      throw new KeyringConfigError(`The active key ${activeKeyId} is not in the keyring.`);
    }
    this.keys = new Map([...keys].map(([keyId, key]) => [keyId, Buffer.from(key)]));
  }

  /**
   * Reads a keyring from its two variables, for example TOKEN_KEKS and TOKEN_KEK_ACTIVE. The
   * messages name the variables and key ids, never key material.
   */
  static fromEnv(
    names: { keys: string; active: string },
    keysValue: string | undefined,
    activeValue: string | undefined,
  ): LocalKeyring {
    const entries = (keysValue ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length === 0) {
      throw new KeyringConfigError(`${names.keys} is empty; generate keys with pnpm gen:keys.`);
    }
    const keys = new Map<string, Buffer>();
    entries.forEach((entry, index) => {
      const separator = entry.indexOf(':');
      const keyId = entry.slice(0, Math.max(separator, 0));
      const encoded = entry.slice(separator + 1);
      const key = Buffer.from(encoded, 'base64');
      if (
        separator <= 0 ||
        !KEY_ID.test(keyId) ||
        key.length !== KEY_BYTES ||
        key.toString('base64') !== encoded
      ) {
        throw new KeyringConfigError(
          `${names.keys}: entry ${String(index + 1)} must be "<key-id>:<base64 ${String(KEY_BYTES)}-byte key>".`,
        );
      }
      if (keys.has(keyId)) {
        throw new KeyringConfigError(`${names.keys}: key id ${keyId} appears twice.`);
      }
      keys.set(keyId, key);
    });
    const active = activeValue?.trim() ?? '';
    if (!keys.has(active)) {
      throw new KeyringConfigError(`${names.active} must name a key id of ${names.keys}.`);
    }
    return new LocalKeyring(keys, active);
  }

  /** The configured key ids, the active one included. */
  get keyIds(): readonly string[] {
    return [...this.keys.keys()];
  }

  wrapKey(dataKey: Uint8Array): Promise<WrappedKey> {
    const key = this.keys.get(this.activeKeyId);
    if (!key) {
      return Promise.reject(new SealedSecretError('UNKNOWN_KEY'));
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(keyIdAad(this.activeKeyId));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Promise.resolve({
      keyId: this.activeKeyId,
      wrappedKey: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
    });
  }

  unwrapKey(keyId: string, wrappedKey: Uint8Array): Promise<Uint8Array> {
    const key = this.keys.get(keyId);
    if (!key) {
      return Promise.reject(new SealedSecretError('UNKNOWN_KEY'));
    }
    const wrapped = Buffer.from(wrappedKey.buffer, wrappedKey.byteOffset, wrappedKey.byteLength);
    if (wrapped.length <= IV_BYTES + TAG_BYTES) {
      return Promise.reject(new SealedSecretError('INVALID'));
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(keyIdAad(keyId));
      decipher.setAuthTag(wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Promise.resolve(
        Buffer.concat([decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]),
      );
    } catch {
      return Promise.reject(new SealedSecretError('INVALID'));
    }
  }
}
