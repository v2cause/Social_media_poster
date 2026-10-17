import { egressPolicy, X_WEB_HOSTS } from '@smp/x-browser';
import type { Browser, Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

import { BrowserHost } from '../src/browser-host';
import { launchChromium } from '../src/chromium';

// Guide step 6.2 with a real Chromium: every task gets a fresh context with the storage state of
// its account, a desktop viewport and the language of the account; the context refuses hosts
// outside the egress policy and waits at most the action timeout. The pages come from fixtures
// (page.route), nothing leaves the machine.

const PAGE = `<!doctype html><html><head><script src="https://abs.twimg.com/main.js"></script></head>
<body><img id="pixel" src="https://tracker.example/pixel.gif"></body></html>`;

/** Serves x.com and twimg.com from fixtures; everything else goes on to the route of the host. */
const fixtures = async (page: Page): Promise<void> => {
  await page.route('**/*', (route) => {
    const { host } = new URL(route.request().url());
    if (host === 'x.com') {
      return route.fulfill({ contentType: 'text/html', body: PAGE });
    }
    if (host === 'abs.twimg.com') {
      return route.fulfill({ contentType: 'application/javascript', body: 'window.loaded = true;' });
    }
    return route.fallback();
  });
};

describe('BrowserHost', () => {
  const launched: Browser[] = [];
  const launch = async (): Promise<Browser> => {
    const browser = await launchChromium({ executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] });
    launched.push(browser);
    return browser;
  };
  const host = new BrowserHost({ launch, policy: egressPolicy(X_WEB_HOSTS), actionTimeoutMs: 1_000 });

  afterAll(async () => {
    await host.close();
    await Promise.all(launched.map((browser) => browser.close().catch(() => undefined)));
  });

  it('runs each task in a fresh context and hands back its storage state', async () => {
    const first = await host.run({ storageState: null, locale: 'de' }, async (page) => {
      await fixtures(page);
      const refused = page.waitForEvent('requestfailed', (request) =>
        request.url().includes('tracker.example'),
      );
      await page.goto('https://x.com/home');
      const failure = (await refused).failure()?.errorText;
      await page.evaluate(() => {
        document.cookie = 'auth_token=abc; path=/; secure';
        localStorage.setItem('theme', 'dim');
      });
      return {
        failure,
        loaded: await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded === true),
        screen: await page.evaluate(() => [window.innerWidth, window.innerHeight, navigator.language]),
      };
    });
    expect(first.result).toEqual({
      ok: true,
      value: {
        failure: expect.stringContaining('ERR_BLOCKED_BY_CLIENT') as string,
        loaded: true,
        screen: [1280, 800, 'de-DE'],
      },
    });
    expect(first.refusedHosts).toEqual(['tracker.example']);
    expect(first.storageState?.cookies.map((cookie) => cookie.name)).toEqual(['auth_token']);
    expect(first.storageState?.origins).toEqual([
      { origin: 'https://x.com', localStorage: [{ name: 'theme', value: 'dim' }] },
    ]);

    const read = async (page: Page) => {
      await fixtures(page);
      await page.goto('https://x.com/home');
      return page.evaluate(() => [document.cookie, localStorage.getItem('theme'), navigator.language]);
    };
    const fresh = await host.run({ storageState: null, locale: 'en' }, read);
    expect(fresh.result).toEqual({ ok: true, value: ['', null, 'en-US'] });
    const resumed = await host.run({ storageState: first.storageState, locale: 'de' }, read);
    expect(resumed.result).toEqual({ ok: true, value: ['auth_token=abc', 'dim', 'de-DE'] });
    expect(launched).toHaveLength(1);
  });

  it('gives every action the timeout and shows the page to onFailure', async () => {
    let seen = '';
    const end = await host.run(
      { storageState: null, locale: 'de' },
      async (page) => {
        await fixtures(page);
        await page.goto('https://x.com/compose/post');
        await page.locator('[data-testid="tweetButton"]').click();
      },
      (page) => {
        seen = page.url();
        return Promise.resolve();
      },
    );
    expect(end.result.ok).toBe(false);
    expect(end.result.ok ? null : (end.result.error as Error).name).toBe('TimeoutError');
    expect(seen).toBe('https://x.com/compose/post');
  });

  it('starts Chromium again after it went away and refuses tasks once closed', async () => {
    await launched[0]?.close();
    const end = await host.run({ storageState: null, locale: 'de' }, (page) => page.evaluate(() => 1 + 1));
    expect(end.result).toEqual({ ok: true, value: 2 });
    expect(launched).toHaveLength(2);

    await host.close();
    await expect(host.run({ storageState: null, locale: 'de' }, () => Promise.resolve(1))).rejects.toThrow(
      /closed/,
    );
  });
});
