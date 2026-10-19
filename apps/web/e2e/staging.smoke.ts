import { expect, test, type Locator, type Page } from '@playwright/test';

import { signUpOwner } from './accounts';

// Smoke test of a staging from the production template (guide step 8.9, ADR 0045), run with
// playwright.staging.config.ts: the verification mail through the worker and Mailpit, the
// onboarding, and an image the browser uploads through the name of the storage, which the worker
// checks and whose thumbnails come back from there.

const run = Date.now().toString(36);
const owner = {
  name: 'Sam Staging',
  email: `staging-${run}@example.test`,
  password: 'blue harbour lantern 2026',
};
const mediaDomain = process.env['STAGING_MEDIA_DOMAIN'] ?? 'media.smp-staging.test';
const FILE = 'staging-smoke.jpg';

/** An image of 1200 x 800 pixels, drawn as a JPEG in the browser. */
async function photo(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('No 2D context.');
    }
    context.fillStyle = '#1e3a8a';
    context.fillRect(0, 0, 1200, 800);
    context.fillStyle = '#f59e0b';
    context.fillRect(300, 200, 600, 400);
    return canvas.toDataURL('image/jpeg', 0.9);
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/** The width of the loaded image; 0 while it loads or when the browser could not load it. */
const loadedWidth = (image: Locator): Promise<number> =>
  image.evaluate((element: HTMLImageElement) => (element.complete ? element.naturalWidth : 0));

test('sign-up, onboarding and an upload through the storage of the staging', async ({ page }) => {
  await signUpOwner(page, owner, `Staging ${run}`);
  const image = await photo(page);

  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Medien' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Medien', exact: true })).toBeVisible();
  const upload = page.waitForResponse(
    (response) => response.request().method() === 'PUT' && new URL(response.url()).hostname === mediaDomain,
  );
  await page
    .getByTestId('media-file-input')
    .setInputFiles({ name: FILE, mimeType: 'image/jpeg', buffer: image });
  expect((await upload).ok()).toBe(true);

  const card = page.getByTestId('media-card').filter({ hasText: FILE });
  await expect(card).toHaveAttribute('data-status', 'READY', { timeout: 60_000 });
  await expect(card).toContainText('1200 x 800 px');
  const thumbnail = card.getByRole('img');
  await expect.poll(() => loadedWidth(thumbnail)).toBeGreaterThan(0);
  const source = await thumbnail.evaluate((element: HTMLImageElement) => element.currentSrc);
  expect(new URL(source).hostname).toBe(mediaDomain);
});
