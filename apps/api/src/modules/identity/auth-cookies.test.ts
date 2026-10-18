import { createCookieGetter, getCookies } from 'better-auth/cookies';
import { describe, expect, it } from 'vitest';

import { authCookieOptions } from './auth';
import { revokeTargetOf } from './revoke-sessions';

// Guide step 8.4: what Better Auth makes of the cookie options of the API.

describe('the cookies of Better Auth', () => {
  it('carry the prefix __Host- over https: Secure, Path=/ and no Domain', () => {
    const env = { NODE_ENV: 'production', BETTER_AUTH_URL: 'https://app.example.com' } as const;
    const options = { baseURL: env.BETTER_AUTH_URL, advanced: authCookieOptions(env) };

    const cookies = getCookies(options);
    const twoFactor = createCookieGetter(options)('two_factor');

    expect(cookies.sessionToken.name).toBe('__Host-smp.session_token');
    expect(cookies.dontRememberToken.name).toBe('__Host-smp.dont_remember');
    expect(twoFactor.name).toBe('__Host-smp.two_factor');
    for (const cookie of [cookies.sessionToken, cookies.dontRememberToken, twoFactor]) {
      expect(cookie.attributes).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'lax' });
      expect(cookie.attributes).not.toHaveProperty('domain');
    }
  });

  it('take https from the URL as well as from production', () => {
    expect(
      authCookieOptions({ NODE_ENV: 'development', BETTER_AUTH_URL: 'https://dev.example.com' }),
    ).toMatchObject({
      cookiePrefix: '__Host-smp',
    });
  });

  it('keep plain names over http in development and tests', () => {
    const env = { NODE_ENV: 'test', BETTER_AUTH_URL: 'http://localhost:3000' } as const;

    const cookies = getCookies({ baseURL: env.BETTER_AUTH_URL, advanced: authCookieOptions(env) });

    expect(cookies.sessionToken.name).toBe('smp.session_token');
    expect(cookies.sessionToken.attributes.secure).toBe(false);
  });
});

describe('revokeTargetOf', () => {
  it('reads --user <email> and --all and nothing else', () => {
    expect(revokeTargetOf(['--user', 'ada@example.test'])).toEqual({ email: 'ada@example.test' });
    expect(revokeTargetOf(['--all'])).toEqual({ all: true });
    expect(revokeTargetOf([])).toBeNull();
    expect(revokeTargetOf(['--user'])).toBeNull();
    expect(revokeTargetOf(['--user', 'not-an-address'])).toBeNull();
    expect(revokeTargetOf(['--all', '--user', 'ada@example.test'])).toBeNull();
  });
});
