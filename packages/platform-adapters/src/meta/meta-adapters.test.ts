import { isPlatformError, systemClock, type PlatformError } from '@smp/core';
import { capabilitiesOf } from '@smp/platform-rules';
import { describeAdapterContract } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { contextFor, failingToken, formOf, IMAGE_URL, noSleep, requestWith } from '../live/fake-platform';
import { FacebookAdapter } from './facebook-adapter';
import { InstagramAdapter } from './instagram-adapter';
import { FakeMeta, IG_USER_ID, PAGE_ID } from './meta.fake';

// Guide step 4.13: the Facebook and Instagram adapters against a fake of the Graph API calls
// they make. "Fertig, wenn" asks for test posts on staging, which need a Meta app.

const VERSION = 'v24.0';
const meta = { appId: 'app-id', appSecret: 'app-secret', graphVersion: VERSION };

const facebookWith = (fake: FakeMeta, loginConfigId?: string): FacebookAdapter =>
  new FacebookAdapter(
    { ...meta, ...(loginConfigId ? { loginConfigId } : {}) },
    { clock: systemClock, fetch: fake.client.fetch, sleep: noSleep },
  );
const instagramWith = (fake: FakeMeta): InstagramAdapter =>
  new InstagramAdapter(meta, { clock: systemClock, fetch: fake.client.fetch, sleep: noSleep });

const pageContext = (token = 'page-token') =>
  contextFor('FACEBOOK', { type: 'PAGE', externalId: PAGE_ID }, { access: token });
const igContext = (token = 'ig-long') =>
  contextFor('INSTAGRAM', { type: 'BUSINESS', externalId: IG_USER_ID }, { access: token });

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
const facebookFake = new FakeMeta(VERSION);
describeAdapterContract({ describe, it, expect }, 'Facebook page', () => facebookWith(facebookFake), {
  accountTypes: ['PAGE'],
  context: (options = {}) =>
    pageContext(
      options.failStatus ? failingToken(options.failStatus, options.retryAfterSeconds) : 'page-token',
    ),
  validRequest: () => requestWith(`Unsere neue Werkstatt in Kiel ist fertig (Teil ${String(++serial)}).`),
  invalidRequest: () => requestWith('x'.repeat(capabilitiesOf('FACEBOOK').text.maxLength + 1)),
});

const instagramFake = new FakeMeta(VERSION);
describeAdapterContract({ describe, it, expect }, 'Instagram', () => instagramWith(instagramFake), {
  accountTypes: ['BUSINESS'],
  context: (options = {}) =>
    igContext(options.failStatus ? failingToken(options.failStatus, options.retryAfterSeconds) : 'ig-long'),
  validRequest: () => requestWith(`Neue Werkstatt in Kiel (Teil ${String(++serial)}) #Handwerk`, 1),
  invalidRequest: () => requestWith('Ohne Bild geht es auf Instagram nicht'),
  removeOnPlatform: (ref) => {
    const media = instagramFake.media.find((entry) => entry.id === ref.externalPostId);
    if (media) {
      media.deleted = true;
    }
    return Promise.resolve();
  },
});

describe('FacebookAdapter', () => {
  it('posts one photo as a file with its alt text', async () => {
    const fake = new FakeMeta(VERSION);

    const result = await facebookWith(fake).publish(
      requestWith('Ein Foto', 1, 'Monteur am Heizkessel'),
      pageContext(),
    );

    expect(result.externalPostId).toMatch(new RegExp(`^${PAGE_ID}_`));
    expect(result.externalUrl).toBe(`https://www.facebook.com/${result.externalPostId}`);
    const [photo] = [...fake.photos.values()];
    expect(photo).toEqual({ published: true, alt: 'Monteur am Heizkessel' });
    const upload = fake.requests.find((request) => request.url.endsWith(`${PAGE_ID}/photos`));
    expect(await formOf(upload as Request)).toMatchObject({
      message: 'Ein Foto',
      published: 'true',
      source: 'file:image/jpeg',
    });
    expect(upload?.headers.get('authorization')).toBe('Bearer page-token');
  });

  it('uploads several photos unpublished and attaches them to one feed post', async () => {
    const fake = new FakeMeta(VERSION);

    await facebookWith(fake).publish(requestWith('Drei Fotos', 3), pageContext());

    expect([...fake.photos.values()].map((photo) => photo.published)).toEqual([false, false, false]);
    expect(fake.pagePosts).toHaveLength(1);
    expect(fake.pagePosts[0]?.photos).toEqual([...fake.photos.keys()]);
  });

  it('maps a duplicate post (error 506) to DUPLICATE', async () => {
    const fake = new FakeMeta(VERSION);
    const adapter = facebookWith(fake);
    await adapter.publish(requestWith('Doppelt'), pageContext());

    expect(await failureOf(adapter.publish(requestWith('Doppelt'), pageContext()))).toMatchObject({
      code: 'DUPLICATE',
      platformCode: '506',
    });
  });

  it('reads reactions, comments and insights, and treats a missing share count as 0', async () => {
    const fake = new FakeMeta(VERSION);
    const adapter = facebookWith(fake);
    const published = await adapter.publish(requestWith('Mit Zahlen'), pageContext());

    const [result] = await adapter.fetchPostMetrics([published], pageContext());

    expect(result).toMatchObject({
      kind: 'metrics',
      metrics: { views: 410, reach: 300, clicks: 12, likes: 21, comments: 3, shares: 0, impressions: null },
    });
  });

  it('asks with scopes, or with the configuration of Facebook Login for Business', () => {
    const fake = new FakeMeta(VERSION);
    const request = {
      state: 's',
      redirectUri: 'https://app.example/api/oauth/facebook/callback',
      codeChallenge: null,
    };

    const scoped = new URL(facebookWith(fake).connector.authorizationUrl(request));
    const configured = new URL(facebookWith(fake, 'cfg-1').connector.authorizationUrl(request));

    expect(scoped.origin + scoped.pathname).toBe(`https://www.facebook.com/${VERSION}/dialog/oauth`);
    expect(scoped.searchParams.get('scope')).toBe(
      'pages_show_list,pages_manage_posts,pages_read_engagement,read_insights',
    );
    expect(configured.searchParams.get('config_id')).toBe('cfg-1');
    expect(configured.searchParams.has('scope')).toBe(false);
  });

  it('exchanges for a long-lived token and offers the pages the user may post to, with their tokens', async () => {
    const fake = new FakeMeta(VERSION);
    const connector = facebookWith(fake).connector;

    const grant = await connector.exchangeCode({ code: 'code-1', redirectUri: 'https://app.example/cb' });
    const pages = await connector.listConnectableAccounts(grant);

    expect(grant).toMatchObject({
      accessToken: 'user-long',
      externalUserId: '5550001',
      scopes: ['pages_show_list', 'pages_manage_posts'],
    });
    expect(pages).toEqual([
      {
        externalId: PAGE_ID,
        type: 'PAGE',
        name: 'Nordlicht Haustechnik',
        handle: null,
        avatarUrl: null,
        accessToken: 'page-token',
      },
    ]);
  });
});

describe('InstagramAdapter', () => {
  it('publishes a carousel: a container per image, then the parent, each waited for until FINISHED', async () => {
    const fake = new FakeMeta(VERSION);
    fake.containerPolls = 1;

    const result = await instagramWith(fake).publish(
      requestWith('Drei Bilder #Kiel', 3, 'Werkstatt'),
      igContext(),
    );

    const containers = [...fake.containers.entries()];
    expect(containers).toHaveLength(4);
    for (const [, child] of containers.slice(0, 3)) {
      expect(child.form).toEqual({ image_url: IMAGE_URL, is_carousel_item: 'true', alt_text: 'Werkstatt' });
    }
    const [parentId, parent] = containers[3] ?? [];
    expect(parent?.form).toMatchObject({ media_type: 'CAROUSEL', caption: 'Drei Bilder #Kiel' });
    expect(result.meta).toEqual({ container: parentId, children: containers.slice(0, 3).map(([id]) => id) });
    expect(result.externalUrl).toBe(`https://www.instagram.com/p/${result.externalPostId}/`);
  });

  it('creates a container once more without its alt text when Instagram refuses the field', async () => {
    const fake = new FakeMeta(VERSION);
    fake.refuseAltText = true;
    const warnings: string[] = [];
    const ctx = contextFor(
      'INSTAGRAM',
      { type: 'BUSINESS', externalId: IG_USER_ID },
      { access: 'ig-long' },
      { warnings },
    );

    await instagramWith(fake).publish(requestWith('Mit Alt-Text', 1, 'Werkstatt'), ctx);

    expect([...fake.containers.values()].map((container) => container.form)).toEqual([
      { image_url: IMAGE_URL, caption: 'Mit Alt-Text' },
    ]);
    expect(fake.media).toHaveLength(1);
    expect(warnings).toEqual(['instagram.alt_text_refused']);
  });

  it('stops before any container when the publishing limit of 24 hours is reached', async () => {
    const fake = new FakeMeta(VERSION);
    fake.quotaUsage = 100;

    const failure = await failureOf(instagramWith(fake).publish(requestWith('Zu viel', 1), igContext()));

    expect(failure).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 3_600_000 });
    expect(fake.containers.size).toBe(0);
  });

  it('gives up with MEDIA_PROCESSING when a container never finishes', async () => {
    const fake = new FakeMeta(VERSION);
    fake.containerPolls = 100;

    const failure = await failureOf(instagramWith(fake).publish(requestWith('Langsam', 1), igContext()));

    expect(failure).toMatchObject({ code: 'MEDIA_PROCESSING', retryable: true });
    expect(fake.media).toHaveLength(0);
  });

  it('renews the long-lived token', async () => {
    const outcome = await instagramWith(new FakeMeta(VERSION)).refreshCredentials(igContext());

    expect(outcome).toMatchObject({
      status: 'refreshed',
      tokens: { accessToken: 'ig-refreshed', scopes: [] },
    });
  });

  it('exchanges the code of the Instagram Login for a long-lived token of the professional account', async () => {
    const fake = new FakeMeta(VERSION);
    const connector = instagramWith(fake).connector;

    const grant = await connector.exchangeCode({ code: 'code-1#_', redirectUri: 'https://app.example/cb' });
    const accounts = await connector.listConnectableAccounts(grant);

    expect(grant).toMatchObject({
      accessToken: 'ig-long',
      externalUserId: IG_USER_ID,
      scopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    });
    expect(accounts).toMatchObject([
      { externalId: IG_USER_ID, type: 'BUSINESS', handle: 'nordlicht.haustechnik' },
    ]);
    const exchange = fake.requests.find(
      (request) => request.url === 'https://api.instagram.com/oauth/access_token',
    );
    expect(await formOf(exchange as Request)).toMatchObject({
      code: 'code-1',
      grant_type: 'authorization_code',
    });
  });
});
