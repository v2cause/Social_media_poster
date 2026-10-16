import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, createNonce, SECURITY_HEADERS } from './content-security-policy';

const directive = (policy: string, name: string): string | undefined =>
  policy
    .split('; ')
    .find((entry) => entry.startsWith(`${name} `))
    ?.slice(name.length + 1);

describe('createNonce', () => {
  it('returns 16 random bytes as base64, different on every call', () => {
    const first = createNonce();
    expect(atob(first)).toHaveLength(16);
    expect(createNonce()).not.toBe(first);
  });
});

describe('buildContentSecurityPolicy', () => {
  it('allows scripts only with the nonce and never inline or from other origins', () => {
    const policy = buildContentSecurityPolicy('abc123', false);
    expect(directive(policy, 'script-src')).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(policy).not.toContain('unsafe-eval');
  });

  it('allows eval only in development', () => {
    expect(directive(buildContentSecurityPolicy('n', true), 'script-src')).toContain("'unsafe-eval'");
  });

  it('blocks framing, plugins and foreign form targets', () => {
    const policy = buildContentSecurityPolicy('n', false);
    expect(directive(policy, 'frame-ancestors')).toBe("'none'");
    expect(directive(policy, 'object-src')).toBe("'none'");
    expect(directive(policy, 'form-action')).toBe("'self'");
    expect(directive(policy, 'base-uri')).toBe("'self'");
  });
});

describe('SECURITY_HEADERS', () => {
  it('sets the baseline headers for every response', () => {
    const keys = SECURITY_HEADERS.map(({ key }) => key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'X-Content-Type-Options',
        'Referrer-Policy',
        'X-Frame-Options',
        'Permissions-Policy',
      ]),
    );
  });
});
