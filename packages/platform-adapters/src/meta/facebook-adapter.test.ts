import { randomUUID } from 'node:crypto';

import { isPlatformError, type AdapterContext, type PublishRequest } from '@smp/core';
import { describe, expect, it, vi } from 'vitest';

import { createFacebookAdapter } from './facebook-adapter';
import { FAKE_APP, FAKE_PAGE_ID, FakeGraph } from './fake-graph';
import { FACEBOOK_SCOPES } from './meta-scopes';

const NOW = new Date('2026-11-25T10:00:00Z');

function setup(options: { loginConfigId?: string } = {}) {
  const graph = new FakeGraph(() => NOW);
  const adapter = createFacebookAdapter({
    app: FAKE_APP,
    clock: { now: () => NOW },
    fetch: graph.fetch,
    ...options,
  });
  const info = vi.fn();
  const ctx: AdapterContext = {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform: 'FACEBOOK',
      type: 'PAGE',
      externalId: FAKE_PAGE_ID,
      name: 'Nordlicht Haustechnik',
      handle: null,
      settings: {},
    },
    credentials: {
      accessToken: () => Promise.resolve('page-token-1'),
      refreshToken: () => Promise.resolve(null),
    },
    costs: { record: () => Promise.resolve() },
    logger: { info, warn: vi.fn() },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive: () => Promise.resolve(),
  };
  return { graph, adapter, ctx, info };
}

const photo = (url: string, altText: string | null = null): PublishRequest['media'][number] => ({
  url,
  mimeType: 'image/jpeg',
  width: 1200,
  height: 900,
  sizeBytes: 4,
  altText,
});

const request = (
  text: string,
  media: PublishRequest['media'] = [],
  linkUrl: string | null = null,
): PublishRequest => ({
  variantId: randomUUID(),
  text,
  firstComment: null,
  linkUrl,
  media,
  contentHash: 'hash',
});

async function failureOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (failed: unknown) => failed,
  );
  if (!isPlatformError(error)) {
    throw new Error(`expected a PlatformError, got ${String(error)}`);
  }
  return error;
}

describe('FacebookConnector', () => {
  it('builds the login dialog with the pinned version, scope, state and redirect URI', () => {
    const { adapter } = setup();
    const url = new URL(
      adapter.connector.authorizationUrl({
        state: 'state-1',
        redirectUri: 'http://localhost:3000/api/oauth/facebook/callback',
        codeChallenge: null,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/v27.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe(FAKE_APP.appId);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/oauth/facebook/callback');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(FACEBOOK_SCOPES.join(','));
    expect(url.searchParams.get('config_id')).toBeNull();
    expect(adapter.connector.usesPkce).toBe(false);
  });

  it('sends config_id instead of scope with a Facebook Login for Business configuration', () => {
    const { adapter } = setup({ loginConfigId: '987654321098765' });
    const url = new URL(
      adapter.connector.authorizationUrl({
        state: 's',
        redirectUri: 'http://localhost:3000/cb',
        codeChallenge: null,
      }),
    );
    expect(url.searchParams.get('config_id')).toBe('987654321098765');
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('exchanges the code for a long-lived user token and reads the granted permissions', async () => {
    const { adapter, graph } = setup();
    const grant = await adapter.connector.exchangeCode({
      code: 'good-code',
      redirectUri: 'http://localhost:3000/api/oauth/facebook/callback',
      codeVerifier: null,
    });
    expect(grant).toMatchObject({
      accessToken: 'long-user-token',
      refreshToken: null,
      accessTokenExpiresAt: null,
      externalUserId: '900000000000001',
      displayName: 'Mira Meta',
    });
    expect(grant.scopes).toEqual(['pages_show_list', 'pages_manage_posts', 'public_profile']);
    const [exchange, longLived] = graph.callsTo('GET', /^\/oauth\/access_token$/);
    expect(exchange?.query.get('redirect_uri')).toBe('http://localhost:3000/api/oauth/facebook/callback');
    expect(longLived?.query.get('grant_type')).toBe('fb_exchange_token');
    expect(longLived?.query.get('fb_exchange_token')).toBe('short-user-token');
  });

  it('refuses a bad code as VALIDATION_REJECTED', async () => {
    const { adapter } = setup();
    const failure = await failureOf(
      adapter.connector.exchangeCode({
        code: 'bad',
        redirectUri: 'http://localhost:3000/cb',
        codeVerifier: null,
      }),
    );
    expect(failure.code).toBe('VALIDATION_REJECTED');
  });

  it('offers the Pages the user can publish to, each with its Page token', async () => {
    const { adapter } = setup();
    const grant = await adapter.connector.exchangeCode({
      code: 'good-code',
      redirectUri: 'x',
      codeVerifier: null,
    });
    const accounts = await adapter.connector.listConnectableAccounts(grant);
    expect(accounts).toEqual([
      {
        externalId: FAKE_PAGE_ID,
        type: 'PAGE',
        name: 'Nordlicht Haustechnik',
        handle: null,
        avatarUrl: 'https://scontent.example.com/p.jpg',
        accessToken: 'page-token-1',
      },
      {
        externalId: '200000000000003',
        type: 'PAGE',
        name: 'Ohne Instagram',
        handle: null,
        avatarUrl: null,
        accessToken: 'page-token-3',
      },
    ]);
  });

  it('revokes only the permissions Instagram does not share', async () => {
    const { adapter, graph } = setup();
    await adapter.connector.revoke({
      accessToken: 'long-user-token',
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scopes: [],
    });
    expect(
      graph.callsTo('DELETE', /^\/me\/permissions$/).map((call) => call.query.get('permission')),
    ).toEqual(['pages_manage_posts', 'pages_read_user_content', 'read_insights']);
  });
});

describe('FacebookAdapter.publish', () => {
  it('posts text with link to the feed, the token in the header and the app secret proof in the query', async () => {
    const { adapter, graph, ctx } = setup();
    const result = await adapter.publish(request('Hallo Kiel', [], 'https://nordlicht.example.com/'), ctx);
    const [call] = graph.callsTo('POST', /\/feed$/);
    expect(call?.path).toBe(`/${FAKE_PAGE_ID}/feed`);
    expect(call?.form?.get('message')).toBe('Hallo Kiel');
    expect(call?.form?.get('link')).toBe('https://nordlicht.example.com/');
    expect(call?.headers.get('authorization')).toBe('Bearer page-token-1');
    expect(call?.query.get('access_token')).toBeNull();
    expect(call?.query.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toEqual({
      externalPostId: expect.stringMatching(new RegExp(`^${FAKE_PAGE_ID}_`)) as unknown,
      externalUrl: `https://www.facebook.com/${result.externalPostId}`,
      publishedAt: NOW,
    });
  });

  it('uploads one photo as multipart bytes from the local storage with caption and alt text', async () => {
    const { adapter, graph, ctx } = setup();
    const url = graph.store('a.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const result = await adapter.publish(
      request('Neue Werkstatt', [photo(url, 'Die Werkstatt von innen')]),
      ctx,
    );
    const [call] = graph.callsTo('POST', /\/photos$/);
    const source = call?.multipart?.get('source');
    expect(source).toBeInstanceOf(Blob);
    expect((source as Blob).size).toBe(4);
    expect(call?.multipart?.get('caption')).toBe('Neue Werkstatt');
    expect(call?.multipart?.get('published')).toBe('true');
    expect(call?.multipart?.get('alt_text_custom')).toBe('Die Werkstatt von innen');
    expect(call?.multipart?.get('url')).toBeNull();
    expect(graph.posts.get(result.externalPostId)?.message).toBe('Neue Werkstatt');
    expect(result.meta).toEqual({ photoIds: [expect.any(String)] });
  });

  it('uploads several photos unpublished and attaches them to one feed post', async () => {
    const { adapter, graph, ctx } = setup();
    const media = ['a.jpg', 'b.jpg', 'c.jpg'].map((name) =>
      photo(graph.store(name, new Uint8Array([1, 2, 3, 4]))),
    );
    const result = await adapter.publish(request('Drei Bilder', media), ctx);
    const uploads = graph.callsTo('POST', /\/photos$/);
    expect(uploads.map((call) => call.multipart?.get('published'))).toEqual(['false', 'false', 'false']);
    const [feed] = graph.callsTo('POST', /\/feed$/);
    const photoIds = result.meta?.photoIds as string[];
    expect(photoIds).toHaveLength(3);
    expect(feed?.form?.get('message')).toBe('Drei Bilder');
    expect(photoIds.map((_, index) => feed?.form?.get(`attached_media[${String(index)}]`))).toEqual(
      photoIds.map((id) => JSON.stringify({ media_fbid: id })),
    );
  });

  it('maps error 190 to AUTH_EXPIRED and 506 to DUPLICATE', async () => {
    const { adapter, graph, ctx } = setup();
    graph.failNext('POST', /\/feed$/, 400, {
      error: { message: 'Invalid token', type: 'OAuthException', code: 190 },
    });
    expect((await failureOf(adapter.publish(request('a'), ctx))).code).toBe('AUTH_EXPIRED');
    graph.failNext('POST', /\/feed$/, 400, {
      error: { message: 'Duplicate', type: 'OAuthException', code: 506 },
    });
    const duplicate = await failureOf(adapter.publish(request('a'), ctx));
    expect(duplicate).toMatchObject({ code: 'DUPLICATE', platformCode: '506', retryable: false });
  });

  it('reports an unreachable storage as TRANSIENT and sends nothing to Facebook', async () => {
    const { adapter, graph, ctx } = setup();
    const failure = await failureOf(
      adapter.publish(request('x', [photo('http://localhost:8333/media/missing.jpg')]), ctx),
    );
    expect(failure.code).toBe('TRANSIENT');
    expect(failure.message).not.toContain('localhost');
    expect(graph.calls).toHaveLength(0);
  });

  it('refuses videos and never reaches publish in a dry run', async () => {
    const { adapter, ctx } = setup();
    const video = { ...photo('http://localhost:8333/v.mp4'), mimeType: 'video/mp4' };
    expect((await failureOf(adapter.publish(request('x', [video]), ctx))).code).toBe('VALIDATION_REJECTED');
    await expect(adapter.publish(request('x'), { ...ctx, dryRun: true })).rejects.toThrow(/dry run/);
  });
});

describe('FacebookAdapter reads', () => {
  it('finds a post again by its text', async () => {
    const { adapter, ctx } = setup();
    const published = await adapter.publish(request('Zeile eins\r\nZeile zwei'), ctx);
    const found = await adapter.reconcile(
      { text: 'Zeile eins\nZeile zwei', since: new Date(NOW.getTime() - 60_000), contentHash: 'h' },
      ctx,
    );
    expect(found?.externalPostId).toBe(published.externalPostId);
  });

  it('normalizes post metrics, keeps the raw answer and reports deleted posts', async () => {
    const { adapter, ctx } = setup();
    const kept = await adapter.publish(request('kept'), ctx);
    const removed = await adapter.publish(request('removed'), ctx);
    await adapter.deletePost(removed, ctx);
    const [first, second] = await adapter.fetchPostMetrics([kept, removed], ctx);
    expect(first).toMatchObject({
      kind: 'metrics',
      mappingVersion: 1,
      metrics: {
        impressions: null,
        views: 150,
        reach: 120,
        likes: 12,
        comments: 3,
        shares: 0,
        clicks: 9,
        saves: null,
      },
    });
    expect(second).toEqual({ kind: 'deleted', externalPostId: removed.externalPostId });
  });

  it('keeps the counters when the insights are not available', async () => {
    const { adapter, graph, ctx } = setup();
    const kept = await adapter.publish(request('kept'), ctx);
    graph.failNext('GET', /\/insights$/, 400, { error: { code: 100, message: 'invalid metric' } });
    const [result] = await adapter.fetchPostMetrics([kept], ctx);
    expect(result).toMatchObject({ kind: 'metrics', metrics: { views: null, likes: 12 } });
  });

  it('stops the batch on a refused token', async () => {
    const { adapter, graph, ctx } = setup();
    const kept = await adapter.publish(request('kept'), ctx);
    graph.failNext('GET', /^\/\d+_\d+$/, 400, { error: { code: 190 } });
    expect((await failureOf(adapter.fetchPostMetrics([kept], ctx))).code).toBe('AUTH_EXPIRED');
  });

  it('reads followers, reach and profile views of the Page', async () => {
    const { adapter, graph, ctx } = setup();
    const result = await adapter.fetchAccountMetrics(
      { from: new Date('2026-11-24T00:00:00Z'), to: NOW },
      ctx,
    );
    expect(result).toMatchObject({ followers: 321, reach: 42, profileViews: 7, mappingVersion: 1 });
    graph.pageInsights = false;
    const small = await adapter.fetchAccountMetrics({ from: new Date('2026-11-24T00:00:00Z'), to: NOW }, ctx);
    expect(small).toMatchObject({ followers: 321, reach: null, profileViews: null });
  });

  it('cannot refresh: a refused Page token needs a new login', async () => {
    const { adapter } = setup();
    await expect(adapter.refreshCredentials()).resolves.toEqual({ status: 'not_supported' });
  });
});
