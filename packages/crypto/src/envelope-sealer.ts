import type { SecretKeyring, SecretRewrapper, SecretSealer } from '@smp/core';

import { open, rewrap, seal } from './envelope';
import type { KmsPort } from './kms';
import { KeyringConfigError, LocalKeyring } from './local-keyring';

// The SecretSealer of the use cases on a KMS: strings in, envelopes out (guide step 4.2).

export class EnvelopeSealer implements SecretSealer, SecretRewrapper {
  constructor(private readonly kms: KmsPort) {}

  seal(plaintext: string, aad: string): Promise<Uint8Array> {
    return seal(Buffer.from(plaintext, 'utf8'), aad, this.kms);
  }

  async open(sealed: Uint8Array, aad: string): Promise<string> {
    const plaintext = await open(sealed, aad, this.kms);
    try {
      return plaintext.toString('utf8');
    } finally {
      plaintext.fill(0);
    }
  }

  rewrap(sealed: Uint8Array): Promise<Uint8Array | null> {
    return rewrap(sealed, this.kms);
  }
}

/** The env variables of the two local keyrings. */
export const KEYRING_ENV: Readonly<Record<SecretKeyring, { keys: string; active: string }>> = {
  tokens: { keys: 'TOKEN_KEKS', active: 'TOKEN_KEK_ACTIVE' },
  sessions: { keys: 'SESSION_KEKS', active: 'SESSION_KEK_ACTIVE' },
};

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A sealer on the local keyring of the env; throws a KeyringConfigError when it is unusable. */
export const sealerFromEnv = (
  keyring: SecretKeyring,
  env: Readonly<Record<string, unknown>>,
): EnvelopeSealer => {
  const names = KEYRING_ENV[keyring];
  return new EnvelopeSealer(LocalKeyring.fromEnv(names, text(env[names.keys]), text(env[names.active])));
};

/** The env variables of the keyring of the e-mail jobs (guide step 8.9, ADR 0039). */
export const NOTIFY_KEYRING_ENV = { keys: 'NOTIFY_KEKS', active: 'NOTIFY_KEK_ACTIVE' } as const;

/**
 * The sealer of the e-mail jobs: their own keyring from NOTIFY_KEKS, which production requires;
 * in development and tests without it the token keyring. Sealed e-mails live only as long as their
 * job, so nothing needs a re-wrap when the keyring changes.
 */
export const notifySealerFromEnv = (env: Readonly<Record<string, unknown>>): EnvelopeSealer => {
  const keys = text(env[NOTIFY_KEYRING_ENV.keys]);
  if (keys === undefined || keys.trim() === '') {
    if (env['NODE_ENV'] === 'production') {
      throw new KeyringConfigError(
        `${NOTIFY_KEYRING_ENV.keys} is required in production; generate keys with pnpm gen:keys.`,
      );
    }
    return sealerFromEnv('tokens', env);
  }
  return new EnvelopeSealer(
    LocalKeyring.fromEnv(NOTIFY_KEYRING_ENV, keys, text(env[NOTIFY_KEYRING_ENV.active])),
  );
};
