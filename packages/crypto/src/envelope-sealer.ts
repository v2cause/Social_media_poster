import type { SecretKeyring, SecretRewrapper, SecretSealer } from '@smp/core';

import { open, rewrap, seal } from './envelope';
import type { KmsPort } from './kms';
import { LocalKeyring } from './local-keyring';

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

/** A sealer on the local keyring of the env; throws a KeyringConfigError when it is unusable. */
export const sealerFromEnv = (
  keyring: SecretKeyring,
  env: Readonly<Record<string, string | undefined>>,
): EnvelopeSealer => {
  const names = KEYRING_ENV[keyring];
  return new EnvelopeSealer(LocalKeyring.fromEnv(names, env[names.keys], env[names.active]));
};
