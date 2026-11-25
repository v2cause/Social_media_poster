import { randomUUID } from 'node:crypto';

import { isPlatformError, type AdapterContext, type PublishRequest } from '@smp/core';
import { describe, expect, it, vi } from 'vitest';

import { FAKE_APP, FAKE_IG_USER_ID, FakeGraph } from './fake-graph';
import { createInstagramAdapter } from './instagram-adapter';
import { INSTAGRAM_SCOPES } from './meta-scopes';

const START = new Date('2026-11-25T10:00:00Z').getTime();

function setup(options: { publicMediaBaseUrl?: string } = {}) {
  let now = START;
  const clock = { now: () => new Date(now) };
  const graph = new FakeGraph(() => clock.now());
  const sleeps: number[] = [];
  const adapter = createInstagramAdapter({
    app: FAKE_APP,
    clock,
    fetch: graph.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    ...options,
  });
  const keepAlive = vi.fn(() => Promise.resolve());
  const warn = vi.fn();
  const ctx: AdapterContext = {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform: 'INSTAGRAM',
      type: 'BUSINESS',
      externalId: FAKE_IG_USER_ID,
      name: 'Nordlicht',
      handle: 'nordlicht.haustechnik',
      settings: {},
    },
    credentials: {
      accessToken: () => Promise.resolve('page-token-1'),
      refreshToken: () => Promise.resolve(null),
    },
    costs: { record: () => Promise.resolve() },
    logger: { info: vi.fn(), warn },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive,
  };
  return { graph, adapter, ctx, sleeps, keepAlive, warn };
}

const SIGNED = 'http://localhost:8333/smp-media/r/a.jpg?X-Amz-Signature=f00';

const jpeg = (url: string, altText: string | null = null): PublishRequest['media'][number] => ({
  url,
  mimeType: 'image/jpeg',
  width: 1080,
  height: 1350,
  sizeBytes: 200_000,
  altText,
});

const request = (text: string, media: PublishRequest['media']): PublishRequest => ({
  variantId: randomUUID(),
  text,
  firstComment: null,
  linkUrl: null,
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

describe('InstagramConnector', () => {
  it('asks for the Instagram permissions through Facebook Login', () => {
    const { adapter } = setup();
    const url = new URL(
      adapter.connector.authorizationUrl({
        state: 'st',
        redirectUri: 'http://localhost:3000/api/oauth/instagram/callback',
        codeChallenge: null,
      }),
    );
    expect(url.host).toBe('www.facebook.com');
    expect(url.searchParams.get('scope')).toBe(INSTAGRAM_SCOPES.join(','));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/oauth/instagram/callback');
  });

  it('offers the Instagram accounts linked to the Pages, with the Page token', async () => {
    const { adapter } = setup();
    const grant = await adapter.connector.exchangeCode({
      code: 'good-code',
      redirectUri: 'x',
      codeVerifier: null,
    });
    expect(await adapter.connector.listConnectableAccounts(grant)).toEqual([
      {
        externalId: FAKE_IG_USER_ID,
        type: 'BUSINESS',
        name: 'Nordlicht',
        handle: 'nordlicht.haustechnik',
        avatarUrl: 'https://scontent.example.com/ig.jpg',
        accessToken: 'page-token-1',
      },
    ]);
  });

  it('revokes only the permissions Facebook does not share', async () => {
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
    ).toEqual([
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_insights',
      'instagram_manage_contents',
    ]);
  });
});

describe('InstagramAdapter.publish', () => {
  it('refuses a local media URL before any call when no public base URL is set', async () => {
    const { adapter, graph, ctx } = setup();
    const failure = await failureOf(adapter.publish(request('Hallo', [jpeg(SIGNED)]), ctx));
    expect(failure).toMatchObject({ code: 'VALIDATION_REJECTED', retryable: false });
    expect(failure.message).toContain('public media base URL');
    expect(graph.calls).toHaveLength(0);
  });

  it('checks the limit, creates the container on the public URL, waits and publishes', async () => {
    const { adapter, graph, ctx, sleeps } = setup({ publicMediaBaseUrl: 'https://media.tunnel.example.com' });
    const result = await adapter.publish(request('Neue Werkstatt #kiel', [jpeg(SIGNED, 'Werkstatt')]), ctx);

    expect(graph.calls.map((call) => `${call.method} ${call.path.replace(/\d{6,}/g, ':id')}`)).toEqual([
      'GET /:id/content_publishing_limit',
      'POST /:id/media',
      'GET /:id',
      'POST /:id/media_publish',
      'GET /:id',
    ]);
    const [create] = graph.callsTo('POST', /\/media$/);
    expect(create?.form?.get('image_url')).toBe(
      'https://media.tunnel.example.com/smp-media/r/a.jpg?X-Amz-Signature=f00',
    );
    expect(create?.form?.get('caption')).toBe('Neue Werkstatt #kiel');
    expect(create?.form?.get('alt_text')).toBe('Werkstatt');
    expect(create?.headers.get('authorization')).toBe('Bearer page-token-1');
    expect(sleeps).toEqual([]);
    expect(result.externalUrl).toBe(`https://www.instagram.com/p/${result.externalPostId}/`);
    expect(result.meta).toEqual({ creationId: expect.any(String) as unknown, childContainerIds: [] });
    expect(graph.media.get(result.externalPostId)?.caption).toBe('Neue Werkstatt #kiel');
  });

  it('creates a carousel: children first, then the parent with caption and children', async () => {
    const { adapter, graph, ctx } = setup();
    const media = ['a', 'b', 'c'].map((name) => jpeg(`https://cdn.example.com/${name}.jpg`));
    const result = await adapter.publish(request('Drei Bilder', media), ctx);
    const creates = graph.callsTo('POST', /\/media$/);
    expect(creates).toHaveLength(4);
    expect(creates.slice(0, 3).map((call) => call.form?.get('is_carousel_item'))).toEqual([
      'true',
      'true',
      'true',
    ]);
    expect(creates.slice(0, 3).map((call) => call.form?.get('caption'))).toEqual([null, null, null]);
    const parent = creates[3]?.form;
    expect(parent?.get('media_type')).toBe('CAROUSEL');
    expect(parent?.get('caption')).toBe('Drei Bilder');
    const children = result.meta?.childContainerIds as string[];
    expect(parent?.get('children')).toBe(children.join(','));
    expect(children).toHaveLength(3);
  });

  it('polls the container status after 5, 15 and 30 seconds and keeps the job alive', async () => {
    const { adapter, graph, ctx, sleeps, keepAlive } = setup();
    graph.containerStatuses = ['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    await adapter.publish(request('Warten', [jpeg('https://cdn.example.com/a.jpg')]), ctx);
    expect(sleeps).toEqual([5_000, 15_000, 30_000]);
    expect(keepAlive).toHaveBeenCalledTimes(3);
  });

  it('gives up after 5 minutes with MEDIA_PROCESSING and publishes nothing', async () => {
    const { adapter, graph, ctx, sleeps } = setup();
    graph.containerStatuses = ['IN_PROGRESS'];
    const failure = await failureOf(
      adapter.publish(request('Zu langsam', [jpeg('https://cdn.example.com/a.jpg')]), ctx),
    );
    expect(failure.code).toBe('MEDIA_PROCESSING');
    expect(sleeps).toEqual([5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(5 * 60_000);
    expect(graph.callsTo('POST', /\/media_publish$/)).toHaveLength(0);
  });

  it('fails a container in ERROR without retries', async () => {
    const { adapter, graph, ctx } = setup();
    graph.containerStatuses = ['ERROR'];
    const failure = await failureOf(
      adapter.publish(request('Kaputt', [jpeg('https://cdn.example.com/a.jpg')]), ctx),
    );
    expect(failure).toMatchObject({ code: 'VALIDATION_REJECTED', retryable: false, platformCode: '2207052' });
  });

  it('stops before creating containers when the publishing limit is used up', async () => {
    const { adapter, graph, ctx } = setup();
    graph.quotaUsage = 50;
    const failure = await failureOf(
      adapter.publish(request('Voll', [jpeg('https://cdn.example.com/a.jpg')]), ctx),
    );
    expect(failure).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3_600_000 });
    expect(graph.callsTo('POST', /\/media$/)).toHaveLength(0);
  });

  it('reports a caption dropped by Instagram in the meta, not as an error', async () => {
    const { adapter, graph, ctx, warn } = setup();
    graph.configIssue = 'CAPTION_NOT_ATTACHED';
    const result = await adapter.publish(
      request('Ohne Caption', [jpeg('https://cdn.example.com/a.jpg')]),
      ctx,
    );
    expect(result.meta?.configIssue).toBe('CAPTION_NOT_ATTACHED');
    expect(warn).toHaveBeenCalled();
  });

  it('turns an unreachable image URL into a clear VALIDATION_REJECTED', async () => {
    const { adapter, graph, ctx } = setup();
    graph.failNext('POST', /\/media$/, 400, { error: { code: 9004, error_subcode: 2207052, message: 'x' } });
    const failure = await failureOf(
      adapter.publish(request('x', [jpeg('https://cdn.example.com/a.jpg')]), ctx),
    );
    expect(failure.code).toBe('VALIDATION_REJECTED');
    expect(failure.message).toContain('public internet');
  });

  it('refuses posts without images or with PNG images', async () => {
    const { adapter, ctx } = setup();
    expect((await failureOf(adapter.publish(request('x', []), ctx))).code).toBe('VALIDATION_REJECTED');
    const png = { ...jpeg('https://cdn.example.com/a.png'), mimeType: 'image/png' };
    expect((await failureOf(adapter.publish(request('x', [png]), ctx))).code).toBe('VALIDATION_REJECTED');
    expect(adapter.validatePost(request('x', [png])).map((issue) => issue.code)).toContain(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });
});

describe('InstagramAdapter reads', () => {
  it('normalizes media insights and reports deleted media', async () => {
    const { adapter, ctx } = setup();
    const kept = await adapter.publish(request('kept', [jpeg('https://cdn.example.com/a.jpg')]), ctx);
    const removed = await adapter.publish(request('removed', [jpeg('https://cdn.example.com/b.jpg')]), ctx);
    await adapter.deletePost(removed, ctx);
    const results = await adapter.fetchPostMetrics([kept, removed], ctx);
    expect(results[0]).toMatchObject({
      kind: 'metrics',
      metrics: {
        impressions: null,
        views: 500,
        reach: 400,
        likes: 30,
        comments: 4,
        shares: null,
        saves: 6,
        clicks: null,
      },
    });
    expect(results[1]).toEqual({ kind: 'deleted', externalPostId: removed.externalPostId });
  });

  it('reads followers and the reach of the account', async () => {
    const { adapter, ctx } = setup();
    const result = await adapter.fetchAccountMetrics(
      { from: new Date(START - 86_400_000), to: new Date(START) },
      ctx,
    );
    expect(result).toMatchObject({ followers: 1234, reach: 224, profileViews: null, mappingVersion: 1 });
  });
});
