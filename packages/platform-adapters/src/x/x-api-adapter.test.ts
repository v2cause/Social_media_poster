import { randomUUID } from 'node:crypto';

import {
  isPlatformError,
  type AdapterContext,
  type Clock,
  type PublishMedia,
  type PublishRequest,
} from '@smp/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_USER, FakeXApi, STORAGE } from './fake-x-api';
import { comparableText, createXAdapter, X_COST_OPERATIONS, type XApiAdapter } from './index';

// Guide step 4.14: posts with images and alt text through the chunked upload, costs per paid call,
// duplicates, the reconcile over the latest 5 posts, rotating refresh tokens, metrics in batches.

const NOW = new Date('2026-11-25T10:00:00.000Z');
const clock: Clock = { now: () => NOW };

interface Recorded {
  operation: string;
  units: number;
}

let api: FakeXApi;
let adapter: XApiAdapter;
let costs: Recorded[];
let logs: Record<string, unknown>[];

const contextWith = (
  overrides: Partial<AdapterContext> = {},
  refreshToken: string | null = null,
): AdapterContext => ({
  account: {
    id: randomUUID(),
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    platform: 'X',
    type: 'PROFILE',
    externalId: FAKE_USER.id,
    name: FAKE_USER.name,
    handle: FAKE_USER.username,
    settings: {},
  },
  credentials: {
    accessToken: () => Promise.resolve('access-0'),
    refreshToken: () => Promise.resolve(refreshToken),
  },
  costs: {
    record: (entry) => {
      costs.push({ operation: entry.operation, units: entry.units ?? 1 });
      return Promise.resolve();
    },
  },
  logger: { info: () => undefined, warn: () => undefined },
  signal: new AbortController().signal,
  dryRun: false,
  keepAlive: () => Promise.resolve(),
  ...overrides,
});

const request = (text: string, extra: Partial<PublishRequest> = {}): PublishRequest => ({
  variantId: randomUUID(),
  text,
  firstComment: null,
  linkUrl: null,
  media: [],
  contentHash: `hash-${randomUUID()}`,
  ...extra,
});

const image = (path: string, bytes: number, extra: Partial<PublishMedia> = {}): PublishMedia => {
  api.storage.set(path, { bytes: new Uint8Array(bytes).fill(7) });
  return {
    url: `${STORAGE}${path}?X-Amz-Signature=secret-signature`,
    mimeType: 'image/jpeg',
    width: 1200,
    height: 675,
    sizeBytes: bytes,
    altText: null,
    ...extra,
  };
};

const failureOf = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (failed: unknown) => failed,
  );
  if (!isPlatformError(error)) {
    throw new Error(`expected a PlatformError, got ${String(error)}`);
  }
  return error;
};

const build = (extra: { ownerUserId?: string } = {}) =>
  createXAdapter({
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    clock,
    fetch: api.fetch,
    logger: { info: (fields) => logs.push(fields), warn: () => undefined },
    maxMediaPollWaitMs: 1,
    ...extra,
  });

beforeEach(() => {
  api = new FakeXApi();
  costs = [];
  logs = [];
  adapter = build();
});

describe('XApiAdapter.publish', () => {
  it('posts the text with POST /2/tweets and records x.post_create', async () => {
    const result = await adapter.publish(request('Neue Werkstatt in Kiel. #Handwerk'), contextWith());

    const [call] = api.calls('POST', '/2/tweets');
    expect(JSON.parse(call?.body ?? '')).toEqual({ text: 'Neue Werkstatt in Kiel. #Handwerk' });
    expect(call?.headers.get('authorization')).toBe('Bearer access-0');
    expect(result).toEqual({
      externalPostId: api.posts[0]?.id,
      externalUrl: `https://x.com/${FAKE_USER.username}/status/${api.posts[0]?.id ?? ''}`,
      publishedAt: NOW,
    });
    expect(costs).toEqual([{ operation: 'x.post_create', units: 1 }]);
  });

  it('records the URL price when the text or the link carries a URL', async () => {
    await adapter.publish(request('Mehr unter https://nordlicht.example/werkstatt'), contextWith());
    await adapter.publish(request('Mit Link', { linkUrl: 'https://nordlicht.example/a' }), contextWith());

    const second = api.calls('POST', '/2/tweets')[1];
    expect(JSON.parse(second?.body ?? '')).toEqual({ text: 'Mit Link\n\nhttps://nordlicht.example/a' });
    expect(costs.map((cost) => cost.operation)).toEqual(['x.post_create_with_url', 'x.post_create_with_url']);
  });

  it('uploads images in chunks, sets the alt text and attaches the media ids in order', async () => {
    const big = image('/media/a.jpg', 4 * 1024 * 1024, { altText: 'Die neue Werkstatt von außen' });
    const small = image('/media/b.jpg', 1000);

    const result = await adapter.publish(request('Zwei Bilder', { media: [big, small] }), contextWith());

    const appends = api.calls('POST', /\/append$/);
    expect(appends.map((call) => (JSON.parse(call.body) as { segment_index: number }).segment_index)).toEqual(
      [0, 1, 0],
    );
    const init = JSON.parse(api.calls('POST', '/2/media/upload/initialize')[0]?.body ?? '') as unknown;
    expect(init).toEqual({
      media_category: 'tweet_image',
      media_type: 'image/jpeg',
      total_bytes: 4 * 1024 * 1024,
    });
    const ids = [...api.uploads.keys()];
    expect(api.uploads.get(ids[0] ?? '')?.altText).toBe('Die neue Werkstatt von außen');
    expect(api.calls('POST', '/2/media/metadata')).toHaveLength(1);
    const post = JSON.parse(api.calls('POST', '/2/tweets')[0]?.body ?? '') as unknown;
    expect(post).toEqual({ text: 'Zwei Bilder', media: { media_ids: ids } });
    expect(result.meta).toEqual({ mediaIds: ids });
    expect(costs).toEqual([
      { operation: X_COST_OPERATIONS.mediaMetadata, units: 1 },
      { operation: 'x.post_create', units: 1 },
    ]);
  });

  it('waits while X processes a GIF', async () => {
    api.gifPolls = 2;
    const gif = image('/media/c.gif', 2000, { mimeType: 'image/gif' });

    await adapter.publish(request('Ein GIF', { media: [gif] }), contextWith());

    expect(api.calls('GET', '/2/media/upload')).toHaveLength(2);
    expect(api.calls('POST', '/2/tweets')).toHaveLength(1);
  });

  it('maps duplicate content to DUPLICATE and records no cost', async () => {
    await adapter.publish(request('Zweimal derselbe Text'), contextWith());
    costs = [];

    const failure = await failureOf(adapter.publish(request('Zweimal derselbe Text'), contextWith()));

    expect(failure).toMatchObject({ code: 'DUPLICATE', retryable: false, status: 403 });
    expect(failure.message).not.toContain('Zweimal');
    expect(costs).toEqual([]);
  });

  it('fails as transient before sending anything when the storage does not answer', async () => {
    const missing: PublishMedia = {
      ...image('/media/x.jpg', 10),
      url: `${STORAGE}/media/missing.jpg?sig=secret`,
    };

    const failure = await failureOf(
      adapter.publish(request('Ohne Bild', { media: [missing] }), contextWith()),
    );

    expect(failure.code).toBe('TRANSIENT');
    expect(failure.message).not.toContain('secret');
    expect(api.calls('POST', '/2/tweets')).toHaveLength(0);
  });

  it('never logs tokens, signatures or bodies', async () => {
    await adapter.publish(
      request('Geheim?', { media: [image('/media/d.jpg', 10, { altText: 'Alt' })] }),
      contextWith(),
    );

    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('access-0');
    expect(logged).not.toContain('Geheim');
    expect(logged).not.toContain(FAKE_CLIENT_SECRET);
  });

  it('refuses media types it cannot upload in validatePost', () => {
    const video: PublishMedia = {
      url: `${STORAGE}/v.mp4`,
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      sizeBytes: 1000,
      altText: null,
    };
    expect(adapter.validatePost(request('Video', { media: [video] }))).toEqual([
      { code: 'UNSUPPORTED_MEDIA_TYPE', mediaIndex: 0 },
    ]);
  });
});

describe('XApiAdapter.reconcile', () => {
  it('reads only the latest 5 own posts and matches the text as X returns it', async () => {
    for (let index = 0; index < 7; index += 1) {
      api.seedPost(`Älterer Post ${String(index)}`, new Date(NOW.getTime() - 3_600_000 + index));
    }
    const sent = api.seedPost('Tom & Jerry <3 https://nordlicht.example/x', new Date(NOW.getTime() + 5_000), [
      '1',
    ]);

    const found = await adapter.reconcile(
      { text: 'Tom & Jerry <3 https://nordlicht.example/x', since: NOW, contentHash: 'h' },
      contextWith(),
    );

    const [call] = api.calls('GET', `/2/users/${FAKE_USER.id}/tweets`);
    expect(call?.search.get('max_results')).toBe('5');
    expect(call?.search.get('tweet.fields')).toBe('created_at,text');
    expect(found).toMatchObject({ externalPostId: sent.id, publishedAt: new Date(sent.createdAt) });
    expect(costs).toEqual([
      { operation: 'x.post_read', units: 5 },
      { operation: 'x.post_create_with_url', units: 1 },
    ]);
  });

  it('records Owned Reads when the account owns the developer app, and finds nothing older', async () => {
    adapter = build({ ownerUserId: FAKE_USER.id });
    api.seedPost('Alter Text', new Date(NOW.getTime() - 3_600_000));

    const found = await adapter.reconcile(
      { text: 'Alter Text', since: NOW, contentHash: 'h' },
      contextWith(),
    );

    expect(found).toBeNull();
    expect(costs).toEqual([{ operation: 'x.owned_post_read', units: 1 }]);
  });

  it('compares texts without entities, t.co links and extra whitespace', () => {
    expect(comparableText('A &amp; B  https://t.co/x https://t.co/media')).toBe(
      comparableText('A & B https://e.example'),
    );
    expect(comparableText('A https://t.co/x B')).not.toBe(comparableText('A B'));
  });
});

describe('XApiAdapter.refreshCredentials', () => {
  it('rotates the refresh token: the new set comes back, the old token is used up', async () => {
    const outcome = await adapter.refreshCredentials(contextWith({}, 'refresh-initial'));

    expect(outcome).toEqual({
      status: 'refreshed',
      tokens: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        accessTokenExpiresAt: new Date(NOW.getTime() + 7_200_000),
        refreshTokenExpiresAt: new Date(NOW.getTime() + 180 * 86_400_000),
        scopes: ['tweet.write', 'users.read', 'tweet.read', 'offline.access', 'media.write'],
      },
    });
    const [call] = api.calls('POST', '/2/oauth2/token');
    expect(new URLSearchParams(call?.body)).toEqual(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'refresh-initial' }),
    );
    expect(call?.headers.get('authorization')).toMatch(/^Basic /);

    const again = await failureOf(adapter.refreshCredentials(contextWith({}, 'refresh-initial')));
    expect(again).toMatchObject({ code: 'AUTH_EXPIRED', platformCode: 'invalid_grant', status: 400 });
  });

  it('reports not_supported without a refresh token', async () => {
    await expect(adapter.refreshCredentials(contextWith())).resolves.toEqual({ status: 'not_supported' });
  });

  it('treats refused app credentials as a setting of the app, not of the account', async () => {
    adapter = createXAdapter({ clientId: FAKE_CLIENT_ID, clientSecret: 'wrong', clock, fetch: api.fetch });
    const failure = await failureOf(adapter.refreshCredentials(contextWith({}, 'refresh-initial')));
    expect(failure).toMatchObject({ code: 'PERMISSION_DENIED', platformCode: 'invalid_client' });
  });
});

describe('XApiAdapter metrics and delete', () => {
  it('reads metrics in batches of 100 and reports unknown posts as deleted', async () => {
    const posts = Array.from({ length: 101 }, (_, index) => api.seedPost(`Post ${String(index)}`, NOW));
    const refs = [
      ...posts.map((post) => ({ externalPostId: post.id, externalUrl: null })),
      { externalPostId: '1', externalUrl: null },
    ];

    const results = await adapter.fetchPostMetrics(refs, contextWith());

    const calls = api.calls('GET', '/2/tweets');
    expect(calls.map((call) => call.search.get('ids')?.split(',').length)).toEqual([100, 2]);
    expect(calls[0]?.search.get('tweet.fields')).toBe('public_metrics,created_at');
    expect(results).toHaveLength(102);
    expect(results[0]).toMatchObject({
      kind: 'metrics',
      mappingVersion: 1,
      metrics: {
        impressions: 1520,
        likes: 31,
        comments: 2,
        shares: 5,
        saves: 3,
        reach: null,
        views: null,
        clicks: null,
      },
    });
    expect(results[101]).toEqual({ kind: 'deleted', externalPostId: '1' });
    expect(costs).toEqual([
      { operation: 'x.post_read', units: 100 },
      { operation: 'x.post_read', units: 1 },
    ]);
  });

  it('reads the followers from GET /2/users/me and records a user read', async () => {
    const metrics = await adapter.fetchAccountMetrics({ from: NOW, to: NOW }, contextWith());

    expect(metrics).toMatchObject({ followers: 1234, reach: null, profileViews: null, mappingVersion: 1 });
    expect(api.calls('GET', '/2/users/me')[0]?.search.get('user.fields')).toBe('public_metrics');
    expect(costs).toEqual([{ operation: 'x.user_read', units: 1 }]);
  });

  it('deletes a post and accepts one that is gone already', async () => {
    const post = api.seedPost('Weg damit', NOW);
    await adapter.deletePost({ externalPostId: post.id, externalUrl: null }, contextWith());
    expect(post.deleted).toBe(true);
    expect(costs).toEqual([{ operation: 'x.post_delete', units: 1 }]);

    await expect(
      adapter.deletePost({ externalPostId: post.id, externalUrl: null }, contextWith()),
    ).resolves.toBeUndefined();
    expect(costs).toHaveLength(1);
  });
});
