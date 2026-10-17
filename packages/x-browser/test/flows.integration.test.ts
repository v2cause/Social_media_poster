import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  accountMetrics,
  canary,
  deletePost,
  detectChallenge,
  isFlowError,
  login,
  postMetrics,
  publish,
  reconcile,
  selectorsV1,
  verifySession,
  type FlowContext,
} from '../src';
import { FakeX, type FakeXOptions } from './fake-x';

// Guide steps 6.3 and 6.6: the flows of selector map x-v1 against local DOM fixtures, served
// through page.route, with JSON answers in the form of the web app. A challenge ends a flow with
// CHALLENGE_REQUIRED, a missing selector with SELECTOR_DRIFT and its name; ids and counters come
// from the answers.

const ctx: FlowContext = {
  selectors: selectorsV1,
  timeoutMs: 3_000,
  now: () => new Date('2026-10-17T08:00:10Z'),
};
// A drift waits for the timeout of one step; the tests keep it short.
const quick: FlowContext = { ...ctx, timeoutMs: 800 };

const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'ok',
    (error: unknown) => (isFlowError(error) ? error.code : `unexpected ${String(error)}`),
  );

describe('flows of selector map x-v1', () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** A fresh page on the fake web app, in the language of the account. */
  const pageOn = async (options: FakeXOptions = {}, locale = 'en-US'): Promise<{ page: Page; x: FakeX }> => {
    if (!browser) {
      throw new Error('Chromium has not started');
    }
    const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const x = new FakeX(options);
    await x.install(page);
    return { page, x };
  };

  it('reads the user of the signed-in session and notices a lost one', async () => {
    const { page } = await pageOn();
    await expect(verifySession(page, ctx)).resolves.toEqual({
      id: '1234567890',
      handle: 'smp_demo',
      name: 'SMP Demo',
      avatarUrl: 'https://pbs.twimg.com/profile_images/1/avatar_normal.jpg',
    });

    const signedOut = await pageOn({ signedIn: false });
    await expect(codeOf(verifySession(signedOut.page, ctx))).resolves.toBe('AUTH_EXPIRED');
  });

  it('posts text over two lines with an image and its alt text, and takes the id from the answer', async () => {
    const { page, x } = await pageOn();
    const posted = await publish(page, ctx, {
      text: 'The launch is today\nSee you there',
      handle: 'smp_demo',
      media: [
        { name: 'image-1.png', mimeType: 'image/png', buffer: Buffer.from('png-bytes'), altText: 'A rocket' },
      ],
    });
    expect(posted).toEqual({
      externalPostId: '1846000000000000001',
      externalUrl: 'https://x.com/smp_demo/status/1846000000000000001',
      publishedAt: '2026-10-17T08:00:05.000Z',
    });
    expect(x.sent).toEqual([
      {
        text: 'The launch is today\nSee you there',
        media: [{ name: 'image-1.png', size: 9, alt: 'A rocket' }],
      },
    ]);
  });

  it('reads the refusals of X and stays unclear without an answer', async () => {
    const post = { text: 'Hello', handle: 'smp_demo', media: [] };
    const duplicate = await pageOn({ createPost: 'duplicate' });
    await expect(codeOf(publish(duplicate.page, ctx, post))).resolves.toBe('DUPLICATE');

    const limited = await pageOn({ createPost: 'rate-limited' });
    const error = await publish(limited.page, ctx, post).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 29 * 60_000 + 50_000 });

    const silent = await pageOn({ createPost: 'silent' });
    await expect(codeOf(publish(silent.page, quick, post))).resolves.toBe('OUTCOME_UNKNOWN');
    expect(silent.x.sent).toHaveLength(1);
  });

  it('ends with SELECTOR_DRIFT and the name of the missing selector, without sending', async () => {
    const { page, x } = await pageOn({ missing: ['tweetButton'] });
    const error = await publish(page, quick, { text: 'Hello', handle: 'smp_demo', media: [] }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: 'SELECTOR_DRIFT', selector: 'composer.submit' });
    expect(x.sent).toEqual([]);

    const noInput = await pageOn({ missing: ['fileInput'] });
    await expect(
      publish(noInput.page, quick, {
        text: 'Hello',
        handle: 'smp_demo',
        media: [{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('x'), altText: null }],
      }),
    ).rejects.toMatchObject({ code: 'SELECTOR_DRIFT', selector: 'composer.fileInput' });
  });

  it('stops at a challenge instead of a drift', async () => {
    const blocked = await pageOn({ challenge: 'compose-redirect' });
    await expect(
      codeOf(publish(blocked.page, ctx, { text: 'Hello', handle: null, media: [] })),
    ).resolves.toBe('CHALLENGE_REQUIRED');
    expect(blocked.x.sent).toEqual([]);

    const captcha = await pageOn({ challenge: 'home-captcha' });
    await expect(codeOf(verifySession(captcha.page, ctx))).resolves.toBe('CHALLENGE_REQUIRED');
    await expect(detectChallenge(captcha.page, selectorsV1)).resolves.toBe(true);
  });

  it('finds a post of the account by its text since a time', async () => {
    const { page } = await pageOn();
    await expect(
      reconcile(page, ctx, {
        handle: 'smp_demo',
        text: 'The launch is today',
        since: new Date('2026-10-17T07:55:00Z'),
      }),
    ).resolves.toEqual({
      externalPostId: '1846000000000000003',
      externalUrl: 'https://x.com/smp_demo/status/1846000000000000003',
      publishedAt: '2026-10-17T07:58:40.000Z',
    });
    await expect(
      reconcile(page, ctx, {
        handle: 'smp_demo',
        text: 'Something else',
        since: new Date('2026-10-17T07:55:00Z'),
      }),
    ).resolves.toBeNull();
    await expect(codeOf(reconcile(page, ctx, { handle: null, text: 'x', since: new Date() }))).resolves.toBe(
      'VALIDATION_REJECTED',
    );
  });

  it('reads the counters of posts and the followers of the account from the answers', async () => {
    const { page } = await pageOn({ deletedPosts: ['1846000000000000002'] });
    const items = await postMetrics(page, ctx, {
      handle: 'smp_demo',
      externalPostIds: ['1846000000000000001', '1846000000000000002'],
    });
    expect(items).toEqual([
      {
        kind: 'metrics',
        externalPostId: '1846000000000000001',
        counts: { views: 4210, likes: 87, replies: 6, reposts: 11, quotes: 2, bookmarks: 9 },
        raw: expect.objectContaining({ rest_id: '1846000000000000001' }) as unknown,
      },
      { kind: 'deleted', externalPostId: '1846000000000000002' },
    ]);
    await expect(accountMetrics(page, ctx, { handle: 'smp_demo' })).resolves.toEqual({
      followers: 1520,
      raw: { id: '1234567890', followers: 1520 },
    });
  });

  it('deletes a post through its menu in the language of the account', async () => {
    const { page, x } = await pageOn({}, 'de-DE');
    await deletePost(page, ctx, { handle: 'smp_demo', externalPostId: '1846000000000000001' });
    expect(x.deleted).toEqual(['1846000000000000001']);
  });

  it('names the selectors the canary misses and posts nothing', async () => {
    const healthy = await pageOn();
    await expect(canary(healthy.page, quick)).resolves.toEqual([]);
    const drifted = await pageOn({ missing: ['accountSwitcher', 'tweetButton', 'fileInput'] });
    await expect(canary(drifted.page, quick)).resolves.toEqual([
      'session.signedIn',
      'composer.submit',
      'composer.fileInput',
    ]);
    expect(drifted.x.sent).toEqual([]);
  });

  describe('login', () => {
    const credentials = { username: 'smp_demo', password: 'correct horse' };

    it('signs in with the user name, the password and the code of the two-factor login', async () => {
      const { page, x } = await pageOn({ signedIn: false, login: { ...credentials, code: '123456' } });
      const asked: number[] = [];
      const user = await login(page, ctx, credentials, {
        code: (attempt) => {
          asked.push(attempt);
          return Promise.resolve(attempt === 1 ? '000000' : '123456');
        },
      });
      expect(user).toMatchObject({ id: '1234567890', handle: 'smp_demo' });
      // The first code was wrong; X asked again.
      expect(asked).toEqual([1, 2]);
      expect(x.codes).toEqual(['000000', '123456']);
    });

    it('signs in without a code when X asks for none', async () => {
      const { page } = await pageOn({ signedIn: false, login: credentials });
      await expect(
        login(page, ctx, credentials, { code: () => Promise.reject(new Error('no code expected')) }),
      ).resolves.toMatchObject({ handle: 'smp_demo' });
    });

    it('fails on a wrong password, on three wrong codes and without a code', async () => {
      const wrong = await pageOn({ signedIn: false, login: credentials });
      await expect(
        codeOf(
          login(
            wrong.page,
            ctx,
            { ...credentials, password: 'wrong' },
            { code: () => Promise.resolve(null) },
          ),
        ),
      ).resolves.toBe('INVALID_CREDENTIALS');

      const codes = await pageOn({ signedIn: false, login: { ...credentials, code: '123456' } });
      await expect(
        codeOf(login(codes.page, ctx, credentials, { code: () => Promise.resolve('999999') })),
      ).resolves.toBe('INVALID_CODE');
      expect(codes.x.codes).toHaveLength(3);

      const none = await pageOn({ signedIn: false, login: { ...credentials, code: '123456' } });
      await expect(
        codeOf(login(none.page, ctx, credentials, { code: () => Promise.resolve(null) })),
      ).resolves.toBe('TIMEOUT');
    });

    it('stops at a step X adds for a suspicious login', async () => {
      const { page } = await pageOn({ signedIn: false, login: { ...credentials, challenge: 'LoginAcid' } });
      await expect(
        codeOf(login(page, ctx, credentials, { code: () => Promise.resolve(null) })),
      ).resolves.toBe('CHALLENGE_REQUIRED');
    });
  });
});
