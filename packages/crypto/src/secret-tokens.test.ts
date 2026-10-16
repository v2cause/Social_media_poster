import { describe, expect, it } from 'vitest';

import { secretTokens, sha256Hex } from './secret-tokens';

describe('secretTokens', () => {
  it('creates 32-byte tokens and stores only their SHA-256 hash', () => {
    const { token, hash } = secretTokens.create();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256Hex(token));
    expect(secretTokens.hash(token)).toBe(hash);
    expect(secretTokens.create().token).not.toBe(token);
  });

  it('creates short suffixes for slugs', () => {
    expect(secretTokens.slugSuffix()).toMatch(/^[a-z2-9]{4}$/);
  });
});
