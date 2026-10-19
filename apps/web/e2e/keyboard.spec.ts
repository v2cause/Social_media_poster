import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';

import { DEMO_WORKSPACE, signInDemo } from './demo';

// Guide step 8.8: the repeatable part of the keyboard check. The skip link is the first stop and
// leads to the content; a menu keeps the focus while it is open and gives it back to its trigger;
// the tabs of the composer are one stop that the arrow keys move through; a dialog keeps the focus
// inside and gives it back as well. The test only reads.

async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.locator('.animate-pulse')).toHaveCount(0);
}

test('the skip link, a menu and a dialog work with the keyboard alone', async ({ page }) => {
  await signInDemo(page, 'owner@demo.local');

  // A fresh load starts the tab order at the top of the page.
  await page.goto(`${DEMO_WORKSPACE}/dashboard`);
  await settle(page);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Zum Inhalt springen' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  // The workspace switcher opens on its first item and keeps the focus until Escape.
  const switcher = page.getByRole('button', { name: 'Workspace wechseln' });
  await switcher.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(switcher).toBeFocused();

  // A dialog takes the focus, keeps it while Tab goes round, and gives it back on Escape.
  const { memberships } = z
    .object({ memberships: z.array(z.object({ organizationId: z.string() })).min(1) })
    .parse(await (await page.request.get('/api/me/memberships')).json());
  await page.goto(`/org/${memberships[0]?.organizationId ?? ''}/members`);
  await settle(page);
  const invite = page.getByRole('button', { name: 'Einladen' });
  await invite.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Person einladen' });
  await expect(dialog).toBeVisible();
  for (let stop = 0; stop < 8; stop += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(invite).toBeFocused();
});

test('the arrow keys move through the variant tabs of the composer', async ({ page }) => {
  await signInDemo(page, 'owner@demo.local');
  const { posts } = z
    .object({ posts: z.array(z.object({ id: z.string(), variants: z.array(z.object({ id: z.string() })) })) })
    .parse(await (await page.request.get(`/api${DEMO_WORKSPACE}/posts?limit=50`)).json());
  const post = posts.find((candidate) => candidate.variants.length >= 2);
  expect(post, 'a post of the seed with two variants or more').toBeDefined();

  await page.goto(`${DEMO_WORKSPACE}/posts/${post?.id ?? ''}`);
  const tabs = page.getByRole('tablist', { name: 'Varianten nach Plattform' }).getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  const count = await tabs.count();

  // One stop in the tab order: the selected tab.
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  const selected = page.getByRole('tab', { selected: true });
  await selected.focus();
  const start = await tabs.evaluateAll((elements) =>
    elements.findIndex((element) => element.getAttribute('aria-selected') === 'true'),
  );

  await page.keyboard.press('ArrowRight');
  const next = tabs.nth((start + 1) % count);
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute('aria-selected', 'true');
  await expect(next).toHaveAttribute('tabindex', '0');

  await page.keyboard.press('End');
  await expect(tabs.nth(count - 1)).toBeFocused();
  await expect(tabs.nth(count - 1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(tabs.first()).toBeFocused();
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(count - 1)).toBeFocused();
});

test('the sticky header never covers the element with the focus', async ({ page }) => {
  // WCAG 2.4.11: a long table, walked forwards and backwards on a short screen.
  await page.setViewportSize({ width: 1280, height: 600 });
  await signInDemo(page, 'owner@demo.local');
  await page.goto(`${DEMO_WORKSPACE}/posts`);
  await settle(page);

  const covered = new Set<string>();
  const check = async () => {
    const found = await page.evaluate(() => {
      const element = document.activeElement;
      const header = document.querySelector('header');
      // The skip link lies above the header; the header and the sidebar never scroll.
      if (
        !element ||
        element === document.body ||
        !header ||
        element.closest('header, aside, [href="#main"]')
      ) {
        return null;
      }
      const box = element.getBoundingClientRect();
      return box.top < header.getBoundingClientRect().bottom - 1 ? element.textContent.trim() : null;
    });
    if (found !== null) {
      covered.add(found);
    }
  };
  for (let stop = 0; stop < 40; stop += 1) {
    await page.keyboard.press('Tab');
    await check();
  }
  for (let stop = 0; stop < 40; stop += 1) {
    await page.keyboard.press('Shift+Tab');
    await check();
  }
  expect([...covered]).toEqual([]);
});
