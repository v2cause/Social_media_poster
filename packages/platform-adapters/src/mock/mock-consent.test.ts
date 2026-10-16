import { describe, expect, it } from 'vitest';

import { PLATFORM_SCOPES } from '../scopes';
import { decodeMockCode, pkceChallengeOf } from './mock-code';
import { MOCK_CODE_TTL_MS, mockConsentLinks } from './mock-consent';
import { MockOAuthConnector } from './mock-oauth-connector';
import { InMemoryMockPlatformStore } from './mock-platform-store';

// The choices of the fake OAuth page lead back to the callback like a real authorization server,
// and the codes they carry pass the code exchange of the mock connector.

const now = Date.parse('2026-10-16T10:00:00Z');
const redirectUri = 'http://localhost:3000/api/oauth/x/callback';
const verifier = 'v'.repeat(64);

const linksFor = (scopes: readonly string[]) =>
  mockConsentLinks({
    platform: 'X',
    state: 'state-1',
    redirectUri,
    scopes,
    codeChallenge: pkceChallengeOf(verifier),
    now,
  });

describe('mockConsentLinks', () => {
  it('grants every requested scope with a code the connector exchanges', async () => {
    const allow = new URL(linksFor(PLATFORM_SCOPES.X).allow);
    expect(`${allow.origin}${allow.pathname}`).toBe(redirectUri);
    expect(allow.searchParams.get('state')).toBe('state-1');
    const code = allow.searchParams.get('code') ?? '';
    expect(decodeMockCode(code)).toMatchObject({
      platform: 'X',
      scopes: PLATFORM_SCOPES.X,
      expiresAt: now + MOCK_CODE_TTL_MS,
    });

    const connector = new MockOAuthConnector('X', {
      authorizeUrl: 'http://localhost:3000/api/dev/mock-oauth/authorize',
      clock: { now: () => new Date(now) },
      store: new InMemoryMockPlatformStore(),
    });
    const grant = await connector.exchangeCode({ code, redirectUri, codeVerifier: verifier });
    expect(grant.scopes).toEqual(PLATFORM_SCOPES.X);
  });

  it('leaves one scope out for the partial grant, only when it was requested', () => {
    const { partial } = linksFor(PLATFORM_SCOPES.X);
    const code = decodeMockCode(new URL(partial?.url ?? redirectUri).searchParams.get('code') ?? '');
    expect(partial?.without).toBe('offline.access');
    expect(code?.scopes).toEqual(PLATFORM_SCOPES.X.filter((scope) => scope !== 'offline.access'));

    expect(linksFor(['tweet.read']).partial).toBeNull();
  });

  it('denies with access_denied and the state', () => {
    const deny = new URL(linksFor(PLATFORM_SCOPES.X).deny);
    expect(deny.searchParams.get('error')).toBe('access_denied');
    expect(deny.searchParams.get('state')).toBe('state-1');
    expect(deny.searchParams.has('code')).toBe(false);
  });

  it('keeps the codes valid only for a while', async () => {
    const code = new URL(linksFor(PLATFORM_SCOPES.X).allow).searchParams.get('code') ?? '';
    const later = new MockOAuthConnector('X', {
      authorizeUrl: 'http://localhost:3000/api/dev/mock-oauth/authorize',
      clock: { now: () => new Date(now + MOCK_CODE_TTL_MS + 1) },
      store: new InMemoryMockPlatformStore(),
    });
    await expect(later.exchangeCode({ code, redirectUri, codeVerifier: verifier })).rejects.toMatchObject({
      code: 'VALIDATION_REJECTED',
    });
  });
});
