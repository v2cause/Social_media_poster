import { isPlatformError } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { createLinkedInAdapter, type LinkedInAdapterOptions } from './create-linkedin-adapter';
import { imageMedia, linkedInContext, publishRequest } from './testing/context';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_JPEG,
  FAKE_ORGANIZATION_URN,
  FAKE_PERSON_URN,
  FAKE_REFRESH_TOKEN,
  FakeLinkedIn,
  type RecordedRequest,
} from './testing/fake-linkedin';

// Guide step 4.12: posts with text and images of a personal profile with the self-serve products,
// the headers of every call, the post id from x-restli-id, and what the port allows where LinkedIn
// gives a member no data.

const NOW = new Date('2026-11-25T10:00:00.000Z');

const setup = (options: Partial<LinkedInAdapterOptions> = {}) => {
  const fake = new FakeLinkedIn();
  const logs: Record<string, unknown>[] = [];
  const waits: number[] = [];
  const adapter = createLinkedInAdapter({
    clientId: FAKE_CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    version: '202611',
    fetch: fake.fetch,
    mediaFetch: fake.fetch,
    clock: { now: () => NOW },
    logger: { info: (fields) => logs.push(fields), warn: (fields) => logs.push(fields) },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { fake, adapter, logs, waits };
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

const restCalls = (fake: FakeLinkedIn): RecordedRequest[] =>
  fake.requests.filter((request) => request.url.pathname.startsWith('/rest/'));

const createCall = (fake: FakeLinkedIn) =>
  fake.requests.find((request) => request.method === 'POST' && request.url.pathname === '/rest/posts');

describe('LinkedInApiAdapter: publishing', () => {
  it('posts the text with the documented body and headers and reads the id from x-restli-id', async () => {
    const { fake, adapter } = setup();
    const result = await adapter.publish(
      publishRequest('Neue Werkstatt (Kiel) ist fertig! #Handwerk @alle'),
      linkedInContext(),
    );

    expect(result.externalPostId).toMatch(/^urn:li:share:\d+$/);
    expect(result.externalUrl).toBe(`https://www.linkedin.com/feed/update/${result.externalPostId}/`);
    expect(result.publishedAt).toEqual(NOW);
    const create = createCall(fake);
    expect(create?.url.toString()).toBe('https://api.linkedin.com/rest/posts');
    expect(create?.headers.get('linkedin-version')).toBe('202611');
    expect(create?.headers.get('x-restli-protocol-version')).toBe('2.0.0');
    expect(create?.headers.get('authorization')).toBe('Bearer AQUvlL_DYEzvT2wz1QJiEPeLioeA');
    expect(create?.body).toEqual({
      author: FAKE_PERSON_URN,
      commentary: 'Neue Werkstatt \\(Kiel\\) ist fertig! {hashtag|\\#|Handwerk} \\@alle',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('downloads an image from the storage, uploads it with the token and posts it with alt text', async () => {
    const { fake, adapter } = setup();
    const result = await adapter.publish(
      publishRequest('Mit Bild', { media: [imageMedia('a.jpg', 'Die neue Werkstatt von außen')] }),
      linkedInContext(),
    );

    const [download, initialize, upload, create] = fake.requests;
    expect(download?.url.hostname).toBe('localhost');
    expect(download?.headers.get('authorization')).toBeNull();
    expect(initialize?.url.toString()).toBe('https://api.linkedin.com/rest/images?action=initializeUpload');
    expect(initialize?.body).toEqual({ initializeUploadRequest: { owner: FAKE_PERSON_URN } });
    expect(upload?.method).toBe('PUT');
    expect(upload?.url.hostname).toBe('www.linkedin.com');
    expect(upload?.url.pathname).toMatch(/^\/dms-uploads\//);
    expect(upload?.headers.get('authorization')).toBe('Bearer AQUvlL_DYEzvT2wz1QJiEPeLioeA');
    expect(upload?.headers.get('content-type')).toBe('image/jpeg');
    expect(upload?.body).toBe(FAKE_JPEG.byteLength);
    // A member token cannot read the image status; the post follows the upload directly.
    expect(fake.requests.some((request) => request.url.pathname.startsWith('/rest/images/'))).toBe(false);
    expect((create?.body as { content: unknown }).content).toEqual({
      media: { id: 'urn:li:image:C4E10AQ00001', altText: 'Die neue Werkstatt von außen' },
    });
    expect(result.externalPostId).toMatch(/^urn:li:ugcPost:\d+$/);
    expect(result.meta).toEqual({ images: ['urn:li:image:C4E10AQ00001'] });
  });

  it('posts several images as multiImage, alt text cut to 4,086 characters', async () => {
    const { fake, adapter } = setup();
    await adapter.publish(
      publishRequest('Galerie', {
        media: [imageMedia('a.jpg', 'x'.repeat(5000)), imageMedia('b.jpg'), imageMedia('c.jpg', '  ')],
      }),
      linkedInContext(),
    );

    const content = (createCall(fake)?.body as { content: { multiImage: { images: unknown[] } } }).content;
    expect(content.multiImage.images).toEqual([
      { id: 'urn:li:image:C4E10AQ00001', altText: 'x'.repeat(4086) },
      { id: 'urn:li:image:C4E10AQ00002' },
      { id: 'urn:li:image:C4E10AQ00003' },
    ]);
  });

  it('waits until a page image is AVAILABLE, and fails on PROCESSING_FAILED', async () => {
    const { fake, adapter, waits } = setup({ features: { organizations: true } });
    fake.imageStatuses = ['WAITING_UPLOAD', 'PROCESSING', 'AVAILABLE'];
    await adapter.publish(
      publishRequest('Seite mit Bild', { media: [imageMedia('a.jpg')] }),
      linkedInContext({ type: 'PAGE' }),
    );
    expect(waits).toEqual([1_000, 2_000, 3_000]);
    const statusCall = fake.requests.find((request) => request.url.pathname.startsWith('/rest/images/'));
    expect(statusCall?.url.pathname).toBe('/rest/images/urn%3Ali%3Aimage%3AC4E10AQ00001');
    expect((createCall(fake)?.body as { author: string }).author).toBe(FAKE_ORGANIZATION_URN);

    const failing = setup({ features: { organizations: true } });
    failing.fake.imageStatuses = ['PROCESSING_FAILED'];
    const error = await failureOf(
      failing.adapter.publish(
        publishRequest('x', { media: [imageMedia('a.jpg')] }),
        linkedInContext({ type: 'PAGE' }),
      ),
    );
    expect(error.code).toBe('VALIDATION_REJECTED');
    expect(createCall(failing.fake)).toBeUndefined();

    const slow = setup({ features: { organizations: true } });
    slow.fake.imageStatuses = ['PROCESSING'];
    const slowError = await failureOf(
      slow.adapter.publish(
        publishRequest('x', { media: [imageMedia('a.jpg')] }),
        linkedInContext({ type: 'PAGE' }),
      ),
    );
    expect(slowError).toMatchObject({ code: 'MEDIA_PROCESSING', retryable: true });
  });

  it('sends the token to LinkedIn hosts only', async () => {
    const { fake, adapter } = setup();
    fake.uploadHost = 'uploads.evil.example';
    const error = await failureOf(
      adapter.publish(publishRequest('x', { media: [imageMedia('a.jpg')] }), linkedInContext()),
    );
    expect(error.code).toBe('TRANSIENT');
    expect(fake.requests.some((request) => request.url.hostname === 'uploads.evil.example')).toBe(false);
  });

  it('retries later when the storage refuses the signed URL, without logging it', async () => {
    const { fake, adapter, logs } = setup();
    const error = await failureOf(
      adapter.publish(publishRequest('x', { media: [imageMedia('expired.jpg')] }), linkedInContext()),
    );
    expect(error).toMatchObject({ code: 'TRANSIENT', retryable: true });
    expect(error.message).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(logs)).not.toContain('X-Amz-Signature');
    expect(restCalls(fake)).toEqual([]);
  });

  it('refuses unsupported images and invalid posts before any call', async () => {
    const { fake, adapter } = setup();
    const webp = { ...imageMedia('a.webp'), mimeType: 'image/webp' };
    expect(
      (await failureOf(adapter.publish(publishRequest('x', { media: [webp] }), linkedInContext()))).code,
    ).toBe('VALIDATION_REJECTED');
    const huge = { ...imageMedia('a.jpg'), width: 7000, height: 6000 };
    expect(
      (await failureOf(adapter.publish(publishRequest('x', { media: [huge] }), linkedInContext()))).code,
    ).toBe('VALIDATION_REJECTED');
    expect((await failureOf(adapter.publish(publishRequest('x'.repeat(3001)), linkedInContext()))).code).toBe(
      'VALIDATION_REJECTED',
    );
    expect(fake.requests).toEqual([]);
  });

  it('reports OUTCOME_UNKNOWN when the created post has no id', async () => {
    const { fake, adapter } = setup();
    fake.omitPostId = true;
    expect((await failureOf(adapter.publish(publishRequest('x'), linkedInContext()))).code).toBe(
      'OUTCOME_UNKNOWN',
    );
  });

  it('maps the LinkedIn-specific answers of the create call', async () => {
    const cases: [number, string, string, boolean][] = [
      [409, 'A write conflict occurred.', 'TRANSIENT', true],
      [422, 'Content is a duplicate of urn:li:share:6844785523593134080', 'DUPLICATE', false],
      [422, 'UNPROCESSABLE_ENTITY', 'VALIDATION_REJECTED', false],
      [426, 'Requested version 20230101 is not active', 'VALIDATION_REJECTED', false],
      [504, 'Gateway Timeout', 'OUTCOME_UNKNOWN', false],
      [400, 'FIELD_LENGTH_TOO_LONG', 'VALIDATION_REJECTED', false],
    ];
    for (const [status, message, code, retryable] of cases) {
      const { fake, adapter } = setup();
      fake.overrides.push((request) =>
        request.url.pathname === '/rest/posts'
          ? new Response(JSON.stringify({ message, serviceErrorCode: 100, status }), { status })
          : undefined,
      );
      const error = await failureOf(adapter.publish(publishRequest('x'), linkedInContext()));
      expect({ status, code: error.code, retryable: error.retryable }).toEqual({ status, code, retryable });
      expect(error.message).not.toContain(message);
    }
  });

  it('adds the first comment after the post, and keeps the post when the comment fails', async () => {
    const { fake, adapter } = setup();
    const result = await adapter.publish(
      publishRequest('Post', { firstComment: 'Mehr unter example.com #info' }),
      linkedInContext(),
    );
    expect(fake.comments).toEqual([
      { post: result.externalPostId, actor: FAKE_PERSON_URN, text: 'Mehr unter example.com #info' },
    ]);
    expect(result.meta).toMatchObject({ firstComment: 'created' });

    const failing = setup();
    failing.fake.commentStatus = 403;
    const kept = await failing.adapter.publish(
      publishRequest('Post', { firstComment: 'Kommentar' }),
      linkedInContext(),
    );
    expect(kept.externalPostId).toMatch(/^urn:li:share:/);
    expect(kept.meta).toMatchObject({ firstComment: 'failed' });
  });

  it('never reaches LinkedIn in a dry run', async () => {
    const { fake, adapter } = setup();
    await expect(
      adapter.publish(publishRequest('x'), { ...linkedInContext(), dryRun: true }),
    ).rejects.toThrow('dry run');
    expect(fake.requests).toEqual([]);
  });

  it('refuses a page account when the app has no Community Management API', async () => {
    const { fake, adapter } = setup();
    const error = await failureOf(adapter.publish(publishRequest('x'), linkedInContext({ type: 'PAGE' })));
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(fake.requests).toEqual([]);
  });

  it('keeps tokens out of the logs', async () => {
    const { adapter, logs } = setup();
    await adapter.publish(publishRequest('x', { media: [imageMedia('a.jpg')] }), linkedInContext());
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('AQUvlL_DYEzvT2wz1QJiEPeLioeA');
  });
});

describe('LinkedInApiAdapter: reconcile, delete, refresh', () => {
  it('cannot reconcile a personal post and says so without a call', async () => {
    const { fake, adapter } = setup();
    const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
    await expect(
      adapter.reconcile({ text: 'x', since: NOW, contentHash: 'h' }, linkedInContext({ logs })),
    ).resolves.toBeNull();
    expect(fake.requests).toEqual([]);
    expect(logs.map((entry) => entry.message)).toEqual(['linkedin.reconcile.not_possible_for_profiles']);
  });

  it('finds a page post by its text among the latest posts', async () => {
    const { fake, adapter } = setup({ features: { organizations: true } });
    const createdAt = Date.now();
    fake.seedPost({
      id: 'urn:li:share:6856921137721544704',
      author: FAKE_ORGANIZATION_URN,
      commentary: 'Follow best practices {hashtag|\\#|coding}',
      createdAt,
    });
    const found = await adapter.reconcile(
      { text: 'Follow best practices #coding', since: new Date(createdAt - 1000), contentHash: 'h' },
      linkedInContext({ type: 'PAGE' }),
    );
    expect(found).toEqual({
      externalPostId: 'urn:li:share:6856921137721544704',
      externalUrl: 'https://www.linkedin.com/feed/update/urn:li:share:6856921137721544704/',
      publishedAt: new Date(createdAt),
    });
    const finder = fake.requests[0];
    expect(finder?.url.search).toBe(
      '?author=urn%3Ali%3Aorganization%3A2414183&q=author&count=20&sortBy=CREATED',
    );
    expect(finder?.headers.get('x-restli-method')).toBe('FINDER');
    await expect(
      adapter.reconcile(
        { text: 'Follow best practices #coding', since: new Date(createdAt + 1000), contentHash: 'h' },
        linkedInContext({ type: 'PAGE' }),
      ),
    ).resolves.toBeNull();
  });

  it('deletes with the encoded URN and treats an unknown post as gone', async () => {
    const { fake, adapter } = setup();
    const ctx = linkedInContext();
    const post = await adapter.publish(publishRequest('weg damit'), ctx);
    await adapter.deletePost(post, ctx);
    const remove = fake.requests.find((request) => request.method === 'DELETE');
    expect(remove?.url.pathname).toBe(`/rest/posts/${encodeURIComponent(post.externalPostId)}`);
    expect(remove?.headers.get('x-restli-method')).toBe('DELETE');
    await expect(
      adapter.deletePost({ externalPostId: 'urn:li:share:1', externalUrl: null }, ctx),
    ).resolves.toBeUndefined();
  });

  it('cannot refresh without a refresh token, and refreshes with one', async () => {
    const { fake, adapter } = setup();
    await expect(adapter.refreshCredentials(linkedInContext())).resolves.toEqual({ status: 'not_supported' });
    expect(fake.requests).toEqual([]);

    const outcome = await adapter.refreshCredentials(linkedInContext({ refreshToken: FAKE_REFRESH_TOKEN }));
    expect(outcome).toEqual({
      status: 'refreshed',
      tokens: {
        accessToken: 'BBBB2kXITHELmWblJigbHEuoFdfRhOwGA0QNnumBI8XOVSs0HtOHE',
        refreshToken: FAKE_REFRESH_TOKEN,
        accessTokenExpiresAt: new Date(NOW.getTime() + 5_184_000_000),
        refreshTokenExpiresAt: new Date(NOW.getTime() + 26_265_600_000),
        scopes: ['openid', 'profile', 'w_member_social'],
      },
    });
    expect(fake.requests[0]?.body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: FAKE_REFRESH_TOKEN,
      client_id: FAKE_CLIENT_ID,
      client_secret: FAKE_CLIENT_SECRET,
    });

    const refused = await failureOf(adapter.refreshCredentials(linkedInContext({ refreshToken: 'revoked' })));
    expect(refused).toMatchObject({ code: 'AUTH_EXPIRED', status: 400 });
  });
});

describe('LinkedInApiAdapter: metrics', () => {
  it('returns no numbers for personal posts without r_member_postAnalytics, and asks nothing', async () => {
    const { fake, adapter } = setup();
    const ctx = linkedInContext();
    const [result] = await adapter.fetchPostMetrics(
      [{ externalPostId: 'urn:li:share:7325786486870552578', externalUrl: null }],
      ctx,
    );
    expect(result).toEqual({
      kind: 'metrics',
      externalPostId: 'urn:li:share:7325786486870552578',
      metrics: {
        impressions: null,
        reach: null,
        views: null,
        likes: null,
        comments: null,
        shares: null,
        clicks: null,
        saves: null,
      },
      raw: { linkedin: { source: 'none', reason: 'MEMBER_POST_ANALYTICS_NOT_ENABLED' } },
      mappingVersion: 1,
    });
    const account = await adapter.fetchAccountMetrics({ from: NOW, to: NOW }, ctx);
    expect(account).toMatchObject({ followers: null, reach: null, profileViews: null, mappingVersion: 1 });
    expect(fake.requests).toEqual([]);
  });

  it('reads personal post metrics through memberCreatorPostAnalytics and reports deleted posts', async () => {
    const { fake, adapter } = setup({
      features: { memberPostAnalytics: true, memberFollowerStatistics: true },
    });
    const ctx = linkedInContext();
    const text = await adapter.publish(publishRequest('Text'), ctx);
    const image = await adapter.publish(publishRequest('Bild', { media: [imageMedia('a.jpg')] }), ctx);
    const removed = await adapter.publish(publishRequest('weg'), ctx);
    await adapter.deletePost(removed, ctx);
    fake.requests.length = 0;

    const results = await adapter.fetchPostMetrics([text, image, removed], ctx);
    expect(results.map((result) => result.kind)).toEqual(['metrics', 'metrics', 'deleted']);
    expect(results[0]).toMatchObject({
      metrics: {
        impressions: 1520,
        reach: 980,
        likes: 41,
        comments: 7,
        shares: 3,
        clicks: null,
        saves: null,
        views: null,
      },
    });
    const entities = fake.requests.map((request) => [
      request.url.searchParams.get('entity'),
      request.url.searchParams.get('queryType'),
    ]);
    expect(entities.slice(0, 5)).toEqual(
      ['IMPRESSION', 'MEMBERS_REACHED', 'REACTION', 'COMMENT', 'RESHARE'].map((metric) => [
        `(share:${text.externalPostId})`,
        metric,
      ]),
    );
    expect(entities[5]).toEqual([`(ugc:${image.externalPostId})`, 'IMPRESSION']);
    expect(fake.requests[0]?.url.search).toContain(
      `entity=(share:${encodeURIComponent(text.externalPostId)})`,
    );

    const account = await adapter.fetchAccountMetrics({ from: NOW, to: NOW }, ctx);
    expect(account).toMatchObject({ followers: 321, mappingVersion: 1 });
  });

  it('returns the metrics read so far when a later call fails', async () => {
    const { fake, adapter } = setup({ features: { memberPostAnalytics: true } });
    const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
    const ctx = linkedInContext({ logs });
    const first = await adapter.publish(publishRequest('eins'), ctx);
    const second = await adapter.publish(publishRequest('zwei'), ctx);
    fake.overrides.push((request) =>
      request.url.searchParams.get('entity')?.includes(second.externalPostId) === true
        ? new Response(JSON.stringify({ message: 'throttled', status: 429 }), { status: 429 })
        : undefined,
    );
    const results = await adapter.fetchPostMetrics([first, second], ctx);
    expect(results.map((result) => result.externalPostId)).toEqual([first.externalPostId]);
    expect(logs).toContainEqual({
      level: 'warn',
      fields: { platform: 'LINKEDIN', code: 'RATE_LIMITED' },
      message: 'linkedin.metrics.partial',
    });
  });
});
