import { isPlatformError } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { linkedInScopes } from './config';
import { createLinkedInAdapter } from './create-linkedin-adapter';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_CODE,
  FAKE_REDIRECT_URI,
  FakeLinkedIn,
  USERINFO_FIXTURE,
} from './testing/fake-linkedin';

// Guide step 4.12: OpenID Connect sign-in plus w_member_social, the person URN from userinfo.sub,
// organizations only with the Community Management API.

const NOW = new Date('2026-11-25T10:00:00.000Z');

const setup = (features: Parameters<typeof createLinkedInAdapter>[0]['features'] = {}) => {
  const fake = new FakeLinkedIn();
  const adapter = createLinkedInAdapter({
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    features,
    fetch: fake.fetch,
    clock: { now: () => NOW },
  });
  return { fake, connector: adapter.connector };
};

const failureOf = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (failed: unknown) => failed,
  );
  if (!isPlatformError(error)) {
    throw new Error('expected a PlatformError');
  }
  return error;
};

describe('linkedInScopes', () => {
  it('asks for the self-serve scopes only, and for approved products on top', () => {
    expect(linkedInScopes()).toEqual(['openid', 'profile', 'w_member_social']);
    expect(
      linkedInScopes({ memberPostAnalytics: true, memberFollowerStatistics: true, organizations: true }),
    ).toEqual([
      'openid',
      'profile',
      'w_member_social',
      'r_member_postAnalytics',
      'r_member_profileAnalytics',
      'w_organization_social',
      'r_organization_social',
      'rw_organization_admin',
    ]);
  });
});

describe('LinkedInOAuthConnector', () => {
  it('builds the authorization URL of the code flow without PKCE', () => {
    const { connector } = setup();
    const url = new URL(
      connector.authorizationUrl({
        state: 'DCEeFWf45A53sdfKef424',
        redirectUri: FAKE_REDIRECT_URI,
        codeChallenge: null,
      }),
    );
    expect(connector.usesPkce).toBe(false);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: FAKE_CLIENT_ID,
      redirect_uri: FAKE_REDIRECT_URI,
      state: 'DCEeFWf45A53sdfKef424',
      scope: 'openid profile w_member_social',
    });
  });

  it('exchanges the code with the client secret in the form body and reads the member', async () => {
    const { fake, connector } = setup();
    const grant = await connector.exchangeCode({
      code: FAKE_CODE,
      redirectUri: FAKE_REDIRECT_URI,
      codeVerifier: null,
    });

    expect(grant).toEqual({
      accessToken: 'AQUvlL_DYEzvT2wz1QJiEPeLioeA',
      refreshToken: null,
      accessTokenExpiresAt: new Date(NOW.getTime() + 5_184_000_000),
      refreshTokenExpiresAt: null,
      scopes: ['openid', 'profile', 'w_member_social'],
      externalUserId: USERINFO_FIXTURE.sub,
      displayName: 'John Doe',
    });
    const [exchange, userinfo] = fake.requests;
    expect(exchange?.url.toString()).toBe('https://www.linkedin.com/oauth/v2/accessToken');
    expect(exchange?.url.search).toBe('');
    expect(exchange?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(exchange?.body).toEqual({
      grant_type: 'authorization_code',
      code: FAKE_CODE,
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
      redirect_uri: FAKE_REDIRECT_URI,
    });
    expect(userinfo?.url.toString()).toBe('https://api.linkedin.com/v2/userinfo');
    expect(userinfo?.headers.get('authorization')).toBe('Bearer AQUvlL_DYEzvT2wz1QJiEPeLioeA');
  });

  it('reads comma-separated granted scopes as well', async () => {
    const { fake, connector } = setup();
    fake.tokenScope = 'openid,profile';
    const grant = await connector.exchangeCode({
      code: FAKE_CODE,
      redirectUri: FAKE_REDIRECT_URI,
      codeVerifier: null,
    });
    expect(grant.scopes).toEqual(['openid', 'profile']);
  });

  it('refuses a wrong code as VALIDATION_REJECTED without the secret in the message', async () => {
    const { connector } = setup();
    const error = await failureOf(
      connector.exchangeCode({ code: 'expired', redirectUri: FAKE_REDIRECT_URI, codeVerifier: null }),
    );
    expect(error).toMatchObject({
      code: 'VALIDATION_REJECTED',
      status: 400,
      platformCode: 'invalid_request',
    });
    expect(error.message).not.toContain(FAKE_CLIENT_SECRET);
    expect(error.message).not.toContain('expired');
  });

  it('offers the personal profile only, without calling the organization APIs', async () => {
    const { fake, connector } = setup();
    const grant = await connector.exchangeCode({
      code: FAKE_CODE,
      redirectUri: FAKE_REDIRECT_URI,
      codeVerifier: null,
    });
    const accounts = await connector.listConnectableAccounts(grant);

    expect(accounts).toEqual([
      {
        externalId: 'urn:li:person:782bbtaQ',
        type: 'PROFILE',
        name: 'John Doe',
        handle: null,
        avatarUrl: USERINFO_FIXTURE.picture,
        accessToken: null,
      },
    ]);
    expect(fake.requests.some((request) => request.url.pathname.startsWith('/rest/'))).toBe(false);
  });

  it('adds the administered pages with the organizations feature', async () => {
    const { fake, connector } = setup({ organizations: true });
    expect(connector.scopes).toContain('rw_organization_admin');
    const grant = await connector.exchangeCode({
      code: FAKE_CODE,
      redirectUri: FAKE_REDIRECT_URI,
      codeVerifier: null,
    });
    fake.organizationAcls.push({
      role: 'ADMINISTRATOR',
      organizationTarget: 'urn:li:organization:999',
      state: 'REQUESTED',
    });
    const accounts = await connector.listConnectableAccounts(grant);

    expect(
      accounts.map((account) => [account.externalId, account.type, account.name, account.handle]),
    ).toEqual([
      ['urn:li:person:782bbtaQ', 'PROFILE', 'John Doe', null],
      ['urn:li:organization:2414183', 'PAGE', 'Devtestco', 'devtestcocompany'],
    ]);
    const acl = fake.requests.find((request) => request.url.pathname === '/rest/organizationAcls');
    expect(acl?.url.searchParams.get('q')).toBe('roleAssignee');
    expect(acl?.url.searchParams.get('role')).toBe('ADMINISTRATOR');
    expect(acl?.url.searchParams.get('state')).toBe('APPROVED');
    const lookup = fake.requests.find((request) => request.url.pathname === '/rest/organizations');
    expect(lookup?.url.search).toBe('?ids=List(2414183)');
  });

  it('revokes nothing remotely, because LinkedIn documents no revocation endpoint', async () => {
    const { fake, connector } = setup();
    await connector.revoke();
    expect(fake.requests).toEqual([]);
  });
});
