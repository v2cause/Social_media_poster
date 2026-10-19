import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { z } from 'zod';

import { expectAccessible } from './axe';
import { DEMO_WORKSPACE, signInDemo } from './demo';

// Guide step 8.8: axe checks the pages, menus and dialogs of the web app against WCAG 2.2 AA
// (architecture 11), in the light and in the dark color scheme. A serious or critical violation
// fails the test; every violation goes into the report as an attachment. The test only reads and
// closes every dialog it opens, so it can run first on the fresh seed and again on the same one.

/** Waits until the page shows its heading and no skeleton of a loading state. */
async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
}

async function visit(page: Page, testInfo: TestInfo, path: string) {
  await page.goto(path);
  await settle(page);
  await expectAccessible(page, testInfo, path);
}

/**
 * An open menu hides the rest of the page from screen readers and keeps the focus inside, as a
 * dialog does; axe knows that only of dialogs with aria-modal and reports the links behind the menu
 * as focusable. The keyboard test checks that the focus stays in the menu.
 */
const MENU_RULES_OFF = ['aria-hidden-focus'];

/** Opens a menu or dialog with its trigger, checks the page with it open, and closes it again. */
async function visitOverlay(
  page: Page,
  testInfo: TestInfo,
  name: string,
  trigger: Locator,
  overlay: Locator,
  skipRules: string[] = [],
) {
  await trigger.click();
  await expect(overlay).toBeVisible();
  await expectAccessible(page, testInfo, name, skipRules);
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
}

/** Reads a list of the API with the session of the page, to find the pages of single items. */
async function apiJson<T>(page: Page, path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), path).toBe(true);
  return schema.parse(await response.json());
}

async function organizationOf(page: Page): Promise<string> {
  const { memberships } = await apiJson(
    page,
    '/api/me/memberships',
    z.object({ memberships: z.array(z.object({ organizationId: z.string() })).min(1) }),
  );
  return memberships[0]?.organizationId ?? '';
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`in the ${colorScheme} color scheme`, () => {
    test.use({ colorScheme });

    test('the pages before the sign-in', async ({ page }, testInfo) => {
      for (const path of ['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email']) {
        await visit(page, testInfo, path);
      }
    });

    test('the pages of a workspace, its organization and the account', async ({ page }, testInfo) => {
      // About 20 pages with an analysis each.
      test.slow();
      await signInDemo(page, 'owner@demo.local');

      const organization = await organizationOf(page);
      const { posts } = await apiJson(
        page,
        `/api${DEMO_WORKSPACE}/posts?limit=1`,
        z.object({ posts: z.array(z.object({ id: z.string() })).min(1) }),
      );
      const { brandVoices } = await apiJson(
        page,
        `/api${DEMO_WORKSPACE}/brand-voices`,
        z.object({ brandVoices: z.array(z.object({ id: z.string() })) }),
      );
      const { items: topPosts } = await apiJson(
        page,
        `/api${DEMO_WORKSPACE}/analytics/top-posts?period=30&limit=1`,
        z.object({
          items: z
            .array(z.object({ variantId: z.string(), account: z.object({ id: z.string() }).nullable() }))
            .min(1),
        }),
      );
      const account = topPosts[0]?.account;
      // The seed has no brand voice; another test may have created one.
      const voice = brandVoices[0];

      const paths = [
        'dashboard',
        'compose',
        'posts',
        `posts/${posts[0]?.id ?? ''}`,
        'calendar',
        'calendar?view=week',
        'calendar?view=list',
        'ideas',
        'media',
        'analytics',
        `analytics/posts/${topPosts[0]?.variantId ?? ''}`,
        ...(account ? [`analytics/accounts/${account.id}`] : []),
        'accounts',
        'brand-voices',
        'brand-voices/new',
        ...(voice ? [`brand-voices/${voice.id}`] : []),
        'settings',
      ].map((path) => `${DEMO_WORKSPACE}/${path}`);
      // The billing page is checked by billing.spec.ts, where the fake Stripe runs: without it the
      // API keeps an incomplete price list for a minute, and that test would see no prices.
      paths.push(
        `/org/${organization}/members`,
        `/org/${organization}/data`,
        '/account/security',
        '/account/notifications',
      );

      for (const path of paths) {
        await visit(page, testInfo, path);
      }
    });

    test('the menus and dialogs', async ({ page }, testInfo) => {
      test.slow();
      await signInDemo(page, 'owner@demo.local');
      const organization = await organizationOf(page);

      await settle(page);
      await visitOverlay(
        page,
        testInfo,
        'workspace switcher',
        page.getByRole('button', { name: 'Workspace wechseln' }),
        page.getByRole('menu'),
        MENU_RULES_OFF,
      );
      await visitOverlay(
        page,
        testInfo,
        'user menu',
        page.getByRole('button', { name: 'Konto von Demo Owner' }),
        page.getByRole('menu'),
        MENU_RULES_OFF,
      );

      await page.goto(`${DEMO_WORKSPACE}/calendar?view=list`);
      await settle(page);
      await visitOverlay(
        page,
        testInfo,
        'reschedule dialog',
        page.getByRole('button', { name: / umplanen$/ }).first(),
        page.getByRole('dialog', { name: 'Umplanen' }),
      );

      await page.goto(`/org/${organization}/members`);
      await settle(page);
      await visitOverlay(
        page,
        testInfo,
        'invitation dialog',
        page.getByRole('button', { name: 'Einladen' }),
        page.getByRole('dialog', { name: 'Person einladen' }),
      );

      await page.goto(`/org/${organization}/data`);
      await settle(page);
      await visitOverlay(
        page,
        testInfo,
        'deletion dialog',
        page.getByRole('button', { name: 'Organisation löschen' }),
        page.getByRole('dialog'),
      );

      // The navigation of narrow screens is a sheet.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${DEMO_WORKSPACE}/dashboard`);
      await settle(page);
      await visitOverlay(
        page,
        testInfo,
        'navigation sheet',
        page.getByRole('button', { name: 'Navigation öffnen' }),
        page.getByRole('dialog'),
      );
    });
  });
}

// WCAG 1.4.10: at 320 CSS pixels no page scrolls sideways; wide tables scroll within their box.
test.describe('at 320 CSS pixels', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('no page scrolls sideways', async ({ page }) => {
    test.slow();
    await signInDemo(page, 'owner@demo.local');
    const organization = await organizationOf(page);
    for (const path of [
      ...[
        'dashboard',
        'compose',
        'posts',
        'calendar',
        'ideas',
        'media',
        'analytics',
        'accounts',
        'settings',
      ].map((section) => `${DEMO_WORKSPACE}/${section}`),
      // The billing page: billing.spec.ts, as above.
      `/org/${organization}/members`,
      '/account/security',
    ]) {
      await page.goto(path);
      await settle(page);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect.soft(width, `width of ${path}`).toBeLessThanOrEqual(320);
    }
  });
});
