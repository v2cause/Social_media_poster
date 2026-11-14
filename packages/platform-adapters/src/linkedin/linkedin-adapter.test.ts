import { isPlatformError, systemClock, type PlatformError } from '@smp/core';
import { capabilitiesOf } from '@smp/platform-rules';
import { describeAdapterContract } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { contextFor, failingToken, formOf, noSleep, requestWith } from '../live/fake-platform';
import { LinkedInAdapter } from './linkedin-adapter';
import type { LinkedInAppConfig } from './linkedin-api';
import { FakeLinkedIn } from './linkedin.fake';

// Guide step 4.12: the LinkedIn adapter against a fake of the calls it makes. "Fertig, wenn" asks
// for the contract suite with fixtures; the real test post on staging needs a LinkedIn app.

const VERSION = '202510';
const ORGANIZATION = 'urn:li:organization:1001';
const PERSON = 'urn:li:person:Ab12Cd';

const config = (overrides: Partial<LinkedInAppConfig> = {}): LinkedInAppConfig => ({
  clientId: 'client-id',
  clientSecret: 'client-secret',
  version: VERSION,
  organizations: false,
  memberAnalytics: false,
  ...overrides,
});

const adapterWith = (fake: FakeLinkedIn, overrides: Partial<LinkedInAppConfig> = {}): LinkedInAdapter =>
  new LinkedInAdapter(config(overrides), { clock: systemClock, fetch: fake.client.fetch, sleep: noSleep });

const failureOf = async (promise: Promise<unknown>): Promise<PlatformError> => {
  const error: unknown = await promise.then(
    () => null,
    (failed: unknown) => failed,
  );
  if (!isPlatformError(error)) {
    throw new Error(`expected a PlatformError, got ${String(error)}`);
  }
  return error;
};

let serial = 0;
const fake = new FakeLinkedIn(VERSION);
describeAdapterContract(
  { describe, it, expect },
  'LinkedIn (company page)',
  () => adapterWith(fake, { organizations: true }),
  {
    accountTypes: ['PAGE', 'PROFILE'],
    context: (options = {}) =>
      contextFor(
        'LINKEDIN',
        { type: 'PAGE', externalId: ORGANIZATION },
        {
          access: options.failStatus
            ? failingToken(options.failStatus, options.retryAfterSeconds)
            : 'access-1',
        },
      ),
    validRequest: () =>
      requestWith(`Unsere neue Werkstatt in Kiel ist fertig (Teil ${String(++serial)}). #Handwerk`),
    invalidRequest: () => requestWith('x'.repeat(capabilitiesOf('LINKEDIN').text.maxLength + 1)),
  },
);

describe('LinkedInAdapter', () => {
  it('posts as the person with the pinned version and the text in little text format', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const adapter = adapterWith(linkedin);
    const ctx = contextFor('LINKEDIN', { type: 'PROFILE', externalId: PERSON }, { access: 'access-1' });

    const result = await adapter.publish(requestWith('Neu (ab Mai): *Wartung* fuer #Waermepumpen'), ctx);

    expect(result.externalPostId).toMatch(/^urn:li:share:/);
    expect(result.externalUrl).toBe(`https://www.linkedin.com/feed/update/${result.externalPostId}/`);
    const [post] = linkedin.posts;
    expect(post).toMatchObject({
      author: PERSON,
      commentary: 'Neu \\(ab Mai\\): \\*Wartung\\* fuer {hashtag|\\#|Waermepumpen}',
    });
    const create = linkedin.requests.find((request) => request.url.endsWith('/rest/posts'));
    expect(create?.headers.get('linkedin-version')).toBe(VERSION);
    expect(create?.headers.get('x-restli-protocol-version')).toBe('2.0.0');
  });

  it('uploads images, waits until LinkedIn has processed them and posts several as multiImage', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    linkedin.processingPolls = 2;
    const adapter = adapterWith(linkedin);
    const ctx = contextFor('LINKEDIN', { type: 'PROFILE', externalId: PERSON }, { access: 'access-1' });

    await adapter.publish(requestWith('Zwei Bilder', 2, 'Monteur am Heizkessel'), ctx);

    const [post] = linkedin.posts;
    const images = [...linkedin.images.keys()];
    expect(images).toHaveLength(2);
    expect(post?.content).toEqual({
      multiImage: { images: images.map((id) => ({ id, altText: 'Monteur am Heizkessel' })) },
    });
    const upload = linkedin.requests.find((request) => request.url.includes('/dms-uploads/'));
    expect(upload?.method).toBe('PUT');
    expect(upload?.headers.get('authorization')).toBe('Bearer access-1');
  });

  it('posts one image as media', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const ctx = contextFor('LINKEDIN', { type: 'PROFILE', externalId: PERSON }, { access: 'access-1' });

    await adapterWith(linkedin).publish(requestWith('Ein Bild', 1), ctx);

    expect(linkedin.posts[0]?.content).toEqual({ media: { id: [...linkedin.images.keys()][0] } });
  });

  it('maps a duplicate post to DUPLICATE', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const adapter = adapterWith(linkedin);
    const ctx = contextFor('LINKEDIN', { type: 'PROFILE', externalId: PERSON }, { access: 'access-1' });
    await adapter.publish(requestWith('Zweimal derselbe Text'), ctx);

    const failure = await failureOf(adapter.publish(requestWith('Zweimal derselbe Text'), ctx));

    expect(failure).toMatchObject({ code: 'DUPLICATE', retryable: false });
  });

  it('finds no personal post by reconcile, so an unclear attempt goes to the user', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const adapter = adapterWith(linkedin);
    const ctx = contextFor('LINKEDIN', { type: 'PROFILE', externalId: PERSON }, { access: 'access-1' });
    const request = requestWith('Persoenlicher Beitrag');
    await adapter.publish(request, ctx);

    await expect(
      adapter.reconcile({ text: request.text, since: new Date(0), contentHash: request.contentHash }, ctx),
    ).resolves.toBeNull();
    expect(linkedin.requests.filter((entry) => entry.url.includes('q=author'))).toHaveLength(0);
  });

  it('posts the first comment after the post and only logs when it fails', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const ctx = contextFor('LINKEDIN', { type: 'PROFILE', externalId: PERSON }, { access: 'access-1' });

    const result = await adapterWith(linkedin).publish(
      { ...requestWith('Mit Kommentar'), firstComment: 'Mehr dazu: (Link folgt)' },
      ctx,
    );

    expect(linkedin.comments).toEqual([
      {
        urn: result.externalPostId,
        body: {
          actor: PERSON,
          object: result.externalPostId,
          message: { text: 'Mehr dazu: \\(Link folgt\\)' },
        },
      },
    ]);
  });

  it('reports no refresh without a refresh token and AUTH_EXPIRED for a spent one', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const adapter = adapterWith(linkedin);
    const person = { type: 'PROFILE' as const, externalId: PERSON };

    await expect(
      adapter.refreshCredentials(contextFor('LINKEDIN', person, { access: 'access-1' })),
    ).resolves.toEqual({ status: 'not_supported' });
    const failure = await failureOf(
      adapter.refreshCredentials(contextFor('LINKEDIN', person, { access: 'access-1', refresh: 'spent' })),
    );
    expect(failure.code).toBe('AUTH_EXPIRED');
  });

  it('reads the impressions of personal posts only with Member Post Analytics', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const ctx = contextFor('LINKEDIN', { type: 'PROFILE', externalId: PERSON }, { access: 'access-1' });
    const ref = { externalPostId: 'urn:li:share:1', externalUrl: null };

    const [without] = await adapterWith(linkedin).fetchPostMetrics([ref], ctx);
    const [withAnalytics] = await adapterWith(linkedin, { memberAnalytics: true }).fetchPostMetrics(
      [ref],
      ctx,
    );

    expect(without).toMatchObject({ kind: 'metrics', metrics: { impressions: null, likes: null } });
    expect(withAnalytics).toMatchObject({
      kind: 'metrics',
      metrics: { impressions: 300, reach: 5, likes: 5 },
    });
  });
});

describe('LinkedInConnector', () => {
  it('asks for the member scopes, and for pages and analytics only when the app has them', () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const request = {
      state: 'state-1',
      redirectUri: 'https://app.example/api/oauth/linkedin/callback',
      codeChallenge: null,
    };

    const member = new URL(adapterWith(linkedin).connector.authorizationUrl(request));
    const all = new URL(
      adapterWith(linkedin, { organizations: true, memberAnalytics: true }).connector.authorizationUrl(
        request,
      ),
    );

    expect(member.origin + member.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(member.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(member.searchParams.get('state')).toBe('state-1');
    expect(all.searchParams.get('scope')).toBe(
      'openid profile w_member_social r_member_postAnalytics w_organization_social r_organization_social rw_organization_admin',
    );
  });

  it('exchanges the code, names the person by OpenID and offers the pages the person may post for', async () => {
    const linkedin = new FakeLinkedIn(VERSION);
    const connector = adapterWith(linkedin, { organizations: true }).connector;

    const grant = await connector.exchangeCode({ code: 'code-1', redirectUri: 'https://app.example/cb' });
    const accounts = await connector.listConnectableAccounts(grant);

    expect(grant).toMatchObject({
      externalUserId: 'Ab12Cd',
      displayName: 'Mira Nordlicht',
      refreshToken: null,
    });
    expect(grant.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(accounts.map((account) => [account.externalId, account.type, account.name])).toEqual([
      [PERSON, 'PROFILE', 'Mira Nordlicht'],
      [ORGANIZATION, 'PAGE', 'Nordlicht Haustechnik'],
    ]);
    const token = linkedin.requests.find((request) => request.url.endsWith('/oauth/v2/accessToken'));
    expect(await formOf(token as Request)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
  });
});
