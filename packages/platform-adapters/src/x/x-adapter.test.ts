import { isPlatformError, systemClock, type PlatformError } from '@smp/core';
import { describeAdapterContract } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { contextFor, failingToken, formOf, noSleep, requestWith } from '../live/fake-platform';
import { XApiAdapter } from './x-adapter';
import { FakeX, X_USER_ID } from './x.fake';

// Guide step 4.14: the adapter of the X API against a fake of the calls it makes, with the costs
// it records. "Fertig, wenn" asks for a test post on staging, which needs an X app with credits.

const adapterWith = (fake: FakeX, clientSecret?: string): XApiAdapter =>
  new XApiAdapter(
    { clientId: 'client-id', ...(clientSecret ? { clientSecret } : {}) },
    { clock: systemClock, fetch: fake.client.fetch, sleep: noSleep },
  );

const account = { type: 'PROFILE' as const, externalId: X_USER_ID, handle: 'nordlicht_ht' };

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
const contractFake = new FakeX();
describeAdapterContract({ describe, it, expect }, 'X API', () => adapterWith(contractFake), {
  accountTypes: ['PROFILE'],
  context: (options = {}) =>
    contextFor('X', account, {
      access: options.failStatus ? failingToken(options.failStatus, options.retryAfterSeconds) : 'access-1',
    }),
  validRequest: () => requestWith(`Neue Werkstatt in Kiel, Teil ${String(++serial)} #Handwerk`),
  invalidRequest: () => requestWith('x'.repeat(281)),
});

describe('XApiAdapter', () => {
  it('uploads images with their alt text, posts them and records the cost of the post', async () => {
    const fake = new FakeX();
    const costs: { operation: string; units: number }[] = [];
    const ctx = contextFor('X', account, { access: 'access-1' }, { costs });

    const result = await adapterWith(fake).publish(
      requestWith('Zwei Bilder', 2, 'Monteur am Heizkessel'),
      ctx,
    );

    const media = [...fake.media.entries()];
    expect(media.map(([, entry]) => entry)).toEqual([
      { category: 'tweet_image', type: 'image/jpeg', altText: 'Monteur am Heizkessel' },
      { category: 'tweet_image', type: 'image/jpeg', altText: 'Monteur am Heizkessel' },
    ]);
    expect(fake.posts[0]?.mediaIds).toEqual(media.map(([id]) => id));
    expect(result.externalUrl).toBe(`https://x.com/nordlicht_ht/status/${result.externalPostId}`);
    expect(costs).toEqual([{ operation: 'x.post_create', units: 1 }]);
  });

  it('posts the image without alt text when X refuses it, and logs that', async () => {
    const fake = new FakeX();
    fake.refuseMetadata = true;
    const warnings: string[] = [];
    const ctx = contextFor('X', account, { access: 'access-1' }, { warnings });

    await adapterWith(fake).publish(requestWith('Ein Bild', 1, 'Monteur am Heizkessel'), ctx);

    expect(fake.posts).toHaveLength(1);
    expect([...fake.media.values()][0]?.altText).toBeNull();
    expect(warnings).toEqual(['x.alt_text_refused']);
  });

  it('records a post with a link at the price of a post with a URL', async () => {
    const costs: { operation: string; units: number }[] = [];
    const ctx = contextFor('X', account, { access: 'access-1' }, { costs });

    await adapterWith(new FakeX()).publish(requestWith('Termine: https://nordlicht.example/termine'), ctx);

    expect(costs).toEqual([{ operation: 'x.post_create_with_url', units: 1 }]);
  });

  it('maps a duplicate post to DUPLICATE and records no cost for it', async () => {
    const fake = new FakeX();
    const costs: { operation: string; units: number }[] = [];
    const ctx = contextFor('X', account, { access: 'access-1' }, { costs });
    const adapter = adapterWith(fake);
    await adapter.publish(requestWith('Zweimal'), ctx);

    const failure = await failureOf(adapter.publish(requestWith('Zweimal'), ctx));

    expect(failure).toMatchObject({ code: 'DUPLICATE', retryable: false });
    expect(costs).toHaveLength(1);
  });

  it('reconciles over the latest five posts only, ignoring shortened links, and pays for every post read', async () => {
    const fake = new FakeX();
    const costs: { operation: string; units: number }[] = [];
    const ctx = contextFor('X', account, { access: 'access-1' }, { costs });
    for (let index = 0; index < 7; index += 1) {
      fake.posts.push({
        id: String(index),
        text: `Alt ${String(index)}`,
        mediaIds: [],
        createdAt: new Date(),
        deleted: false,
      });
    }
    fake.posts.push({
      id: '99',
      text: 'Mehr unter https://t.co/abc123',
      mediaIds: [],
      createdAt: new Date(),
      deleted: false,
    });

    const found = await adapterWith(fake).reconcile(
      {
        text: 'Mehr unter https://nordlicht.example/x',
        since: new Date(Date.now() - 60_000),
        contentHash: 'h',
      },
      ctx,
    );

    expect(found?.externalPostId).toBe('99');
    expect(costs).toEqual([{ operation: 'x.post_read', units: 5 }]);
    const timeline = fake.requests.find((request) => request.url.includes('/tweets?'));
    expect(new URL(timeline?.url ?? '').searchParams.get('max_results')).toBe('5');
  });

  it('renews with the refresh token, which X spends, and reports a spent one as AUTH_EXPIRED', async () => {
    const fake = new FakeX();
    const adapter = adapterWith(fake, 'client-secret');

    const outcome = await adapter.refreshCredentials(
      contextFor('X', account, { access: 'a', refresh: 'refresh-1' }),
    );
    const again = await failureOf(
      adapter.refreshCredentials(contextFor('X', account, { access: 'a', refresh: 'refresh-1' })),
    );

    expect(outcome.status === 'refreshed' ? outcome.tokens.refreshToken : null).toMatch(/^refresh-/);
    expect(again.code).toBe('AUTH_EXPIRED');
    const token = fake.requests.find((request) => request.url.endsWith('/2/oauth2/token'));
    expect(token?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );
    expect(await formOf(token as Request)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
    });
  });

  it('reads the metrics of many posts in one lookup and reports unknown ones as deleted', async () => {
    const fake = new FakeX();
    const costs: { operation: string; units: number }[] = [];
    const ctx = contextFor('X', account, { access: 'access-1' }, { costs });
    const adapter = adapterWith(fake);
    const kept = await adapter.publish(requestWith('Bleibt'), ctx);
    costs.length = 0;

    const results = await adapter.fetchPostMetrics([kept, { externalPostId: '404', externalUrl: null }], ctx);

    expect(results).toEqual([
      expect.objectContaining({
        kind: 'metrics',
        metrics: {
          impressions: 640,
          reach: null,
          views: null,
          likes: 9,
          comments: 1,
          shares: 3,
          clicks: null,
          saves: 3,
        },
      }),
      { kind: 'deleted', externalPostId: '404' },
    ]);
    expect(costs).toEqual([{ operation: 'x.post_read', units: 1 }]);
  });
});

describe('XConnector', () => {
  it('asks with PKCE (S256) for the scopes of the architecture', () => {
    const url = new URL(
      adapterWith(new FakeX()).connector.authorizationUrl({
        state: 's',
        redirectUri: 'https://app.example/api/oauth/x/callback',
        codeChallenge: 'challenge',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-id',
      scope: 'tweet.read tweet.write users.read media.write offline.access',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code with the verifier, as a public client without a secret', async () => {
    const fake = new FakeX();
    const connector = adapterWith(fake).connector;

    const grant = await connector.exchangeCode({
      code: 'code-1',
      redirectUri: 'https://app.example/cb',
      codeVerifier: 'verifier',
    });
    const accounts = await connector.listConnectableAccounts(grant);

    expect(grant).toMatchObject({ externalUserId: X_USER_ID, displayName: 'Nordlicht Haustechnik' });
    expect(grant.refreshToken).toMatch(/^refresh-/);
    expect(accounts).toMatchObject([{ externalId: X_USER_ID, type: 'PROFILE', handle: 'nordlicht_ht' }]);
    const token = fake.requests.find((request) => request.url.endsWith('/2/oauth2/token'));
    expect(token?.headers.get('authorization')).toBeNull();
    expect(await formOf(token as Request)).toMatchObject({
      grant_type: 'authorization_code',
      code_verifier: 'verifier',
      client_id: 'client-id',
    });
  });
});
