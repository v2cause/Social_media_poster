import { createHash, randomBytes, randomInt } from 'node:crypto';

import type { SecretTokens } from '@smp/core';

const SUFFIX_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SUFFIX_LENGTH = 4;

/** SHA-256 as lowercase hex. Tokens have 256 bits of entropy, so a fast hash is enough. */
export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Link tokens from 32 random bytes (base64url) and their hashes (guide step 1.5). */
export const secretTokens: SecretTokens = {
  create() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: sha256Hex(token) };
  },
  hash: sha256Hex,
  slugSuffix() {
    return Array.from(
      { length: SUFFIX_LENGTH },
      () => SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)],
    ).join('');
  },
};
