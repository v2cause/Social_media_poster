import { isPlatformError, type Clock } from '@smp/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { pkceChallengeOf } from '../mock/mock-code';
import { PLATFORM_SCOPES } from '../scopes';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_USER, FakeXApi } from './fake-x-api';
import { altTextOf, containsUrl, createXAdapter, normalizeXPostMetrics, postCreateOperation } from './index';

// Guide step 4.14: OAuth 2.0 with PKCE S256 for a confidential client, the account of the grant,
// revoke; the URL surcharge and the metrics mapping.

const NOW = new Date('2026-11-25T10:00:00.000Z');
const clock: Clock = { now: () => NOW };
const REDIRECT = 'http://127.0.0.1:3000/api/oauth/x/callback';

let api: FakeXApi;
const connector = () =>
  createXAdapter({ clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, clock, fetch: api.fetch })
    .connector;

beforeEach(() => {
  api = new FakeXApi();
});

describe('XOAuthConnector', () => {
  it('builds the authorize URL with S256 and the scopes of architecture 4.2', () => {
    const challenge = pkceChallengeOf('verifier-1234567890-verifier-1234567890-abc');
    const url = new URL(
      connector().authorizationUrl({ state: 'state-1', redirectUri: REDIRECT, codeChallenge: challenge }),
    );

    expect(`${url.origin}${url.pathname}`).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: FAKE_CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'tweet.read tweet.write users.read media.write offline.access',
      state: 'state-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(url.search).toContain('scope=tweet.read%20tweet.write');
    expect(connector().scopes).toEqual(PLATFORM_SCOPES.X);
    expect(connector().usesPkce).toBe(true);
  });

  it('refuses to start without a code challenge', () => {
    expect(() =>
      connector().authorizationUrl({ state: 's', redirectUri: REDIRECT, codeChallenge: null }),
    ).toThrow(/PKCE/);
  });

  it('exchanges the code with HTTP Basic and the verifier and lists the one profile', async () => {
    const subject = connector();
    const grant = await subject.exchangeCode({
      code: 'code-ok',
      redirectUri: REDIRECT,
      codeVerifier: 'verifier',
    });

    const [token] = api.calls('POST', '/2/oauth2/token');
    expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({
      code: 'code-ok',
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
      code_verifier: 'verifier',
    });
    expect(token?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(grant).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(NOW.getTime() + 7_200_000),
      externalUserId: FAKE_USER.id,
      displayName: FAKE_USER.name,
    });
    expect(grant.scopes).toContain('offline.access');

    await expect(subject.listConnectableAccounts(grant)).resolves.toEqual([
      {
        externalId: FAKE_USER.id,
        type: 'PROFILE',
        name: FAKE_USER.name,
        handle: FAKE_USER.username,
        avatarUrl: 'https://pbs.twimg.com/profile_images/1/mira_normal.jpg',
        accessToken: null,
      },
    ]);
    // The profile of the exchange is reused: one paid user read, not two.
    expect(api.calls('GET', '/2/users/me')).toHaveLength(1);
  });

  it('maps a refused code to VALIDATION_REJECTED', async () => {
    const error: unknown = await connector()
      .exchangeCode({ code: 'expired', redirectUri: REDIRECT, codeVerifier: 'verifier' })
      .catch((failed: unknown) => failed);
    expect(isPlatformError(error) && error.code).toBe('VALIDATION_REJECTED');
  });

  it('revokes the refresh and the access token', async () => {
    await connector().revoke({
      accessToken: 'access-9',
      refreshToken: 'refresh-9',
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: [],
    });
    expect(api.revoked).toEqual(['refresh-9', 'access-9']);
  });

  it('refuses an invalid configuration without naming the secret', () => {
    expect(() => createXAdapter({ clientId: '', clientSecret: 'top-secret-value' })).toThrow(/clientId/);
    expect(() => createXAdapter({ clientId: '', clientSecret: 'top-secret-value' })).not.toThrow(
      /top-secret/,
    );
  });
});

describe('X costs and metrics mapping', () => {
  it('detects the URLs that make a post cost more', () => {
    expect(containsUrl('Mehr unter https://nordlicht.example')).toBe(true);
    expect(containsUrl('Besuch www.nordlicht.de')).toBe(true);
    expect(containsUrl('Infos auf nordlicht.de/werkstatt!')).toBe(true);
    expect(containsUrl('Kosten z.B. 1.5 Euro, d.h. wenig')).toBe(false);
    expect(containsUrl('Kein Link, nur #Handwerk und @mira')).toBe(false);
    expect(postCreateOperation('Ohne Link')).toBe('x.post_create');
  });

  it('cuts the alt text to 1000 UTF-16 code units at whole graphemes', () => {
    expect(altTextOf(`  ${'a'.repeat(999)}\u{1F600}b  `)).toBe('a'.repeat(999));
    expect(altTextOf(' Werkstatt ')).toBe('Werkstatt');
  });

  it('maps public_metrics with repost_count or retweet_count and keeps missing values null', () => {
    expect(
      normalizeXPostMetrics({
        id: '1',
        public_metrics: {
          repost_count: 2,
          quote_count: 1,
          like_count: 5,
          reply_count: 0,
          impression_count: 90,
        },
      }),
    ).toEqual({
      impressions: 90,
      reach: null,
      views: null,
      likes: 5,
      comments: 0,
      shares: 3,
      clicks: null,
      saves: null,
    });
    expect(normalizeXPostMetrics({ id: '1', public_metrics: { retweet_count: 4 } }).shares).toBe(4);
    expect(normalizeXPostMetrics({ id: '1' }).shares).toBeNull();
  });
});
