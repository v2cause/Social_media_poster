import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { signUpOwner, type Person } from './accounts';
import { linkFromEmail } from './mailpit';

// Guide step 8.2 through the web app and the API: a new owner deletes the organization on the
// data page by typing its name. From then on every page of the organization says that it was
// deleted and on which day it is erased; only the data page still works, and the owner gets the
// email with the day. Taking the deletion back there brings everything back. With E2E_SHOTS_DIR
// the test keeps screenshots of the states it passes.

const shots = process.env['E2E_SHOTS_DIR'];

/** The whole page in one viewport, so that the sticky header and sidebar stay in their place. */
const shot = async (page: Page, name: string) => {
  if (!shots) {
    return;
  }
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: Math.max(height, viewport.height) });
  await page.screenshot({ path: join(shots, `${name}.png`) });
  await page.setViewportSize(viewport);
};

test('the owner deletes the organization and takes the deletion back', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const owner: Person = {
    name: 'Lotte Löscher',
    email: `deletion-${stamp}@e2e.test`,
    password: 'a-long-password-for-the-deletion',
  };
  const workspacePath = await signUpOwner(page, owner, `Abschied ${stamp}`);
  const organizationName = `Abschied ${stamp} GmbH`;

  await page.getByRole('button', { name: `Konto von ${owner.name}` }).click();
  await page.getByRole('menuitem', { name: 'Team' }).click();
  await expect(page).toHaveURL(/\/org\/[0-9a-f-]+\/members$/);
  const organizationId = /\/org\/([0-9a-f-]+)\/members/.exec(page.url())?.[1] ?? '';
  await page.getByRole('link', { name: 'Daten und Löschung' }).click();
  await expect(page).toHaveURL(new RegExp(`/org/${organizationId}/data$`));
  await expect(page.getByText('Endgültig gelöscht wird nach 30 Tagen.', { exact: false })).toBeVisible();

  // The organization goes only with its name typed.
  await page.getByRole('button', { name: 'Organisation löschen' }).click();
  const dialog = page.getByRole('dialog', { name: `${organizationName} wirklich löschen?` });
  const confirm = dialog.getByRole('button', { name: 'Organisation löschen' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Name der Organisation').fill('Abschied GmbH');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Name der Organisation').fill(organizationName);
  await expect(confirm).toBeEnabled();
  await shot(page, 'deletion-dialog');
  await confirm.click();

  await expect(
    page.getByText(/^Die Organisation wurde gelöscht\. Sie wird am .+ endgültig gelöscht\.$/),
  ).toBeVisible();
  await expect(page.getByText('Löschung geplant')).toBeVisible();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /^Diese Organisation wurde gelöscht und wird am .+ endgültig gelöscht\./ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Löschung zurücknehmen' })).toBeVisible();
  // The data export stays until the erasure.
  await expect(page.getByRole('button', { name: 'Export anfordern' })).toBeEnabled();
  await shot(page, 'deletion-pending');

  // Every other page of the organization explains the deletion instead.
  await page.goto(`${workspacePath}/posts`);
  await expect(page.getByText('Diese Organisation wurde gelöscht', { exact: true })).toBeVisible();
  await expect(page.getByText(/Am .+ wird sie mit allen Daten endgültig gelöscht\./)).toBeVisible();
  await shot(page, 'deletion-blocked');

  const mail = await linkFromEmail(owner.email, /http:\/\/\S+\/org\/[0-9a-f-]+\/data/);
  expect(mail.subject).toMatch(new RegExp(`^${organizationName} wird am .+ endgültig gelöscht$`));
  expect(mail.url).toBe(`http://localhost:3000/org/${organizationId}/data`);

  // Taking the deletion back brings the organization back for everyone.
  await page.getByRole('main').getByRole('link', { name: 'Zur Löschung' }).click();
  await expect(page).toHaveURL(new RegExp(`/org/${organizationId}/data$`));
  await page.getByRole('button', { name: 'Löschung zurücknehmen' }).click();
  await expect(
    page.getByText('Die Löschung wurde zurückgenommen. Die Organisation steht wieder zur Verfügung.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Organisation löschen' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Diese Organisation wurde gelöscht' })).toHaveCount(
    0,
  );
  await page.goto(`${workspacePath}/posts`);
  await expect(page.getByRole('heading', { level: 1, name: 'Beiträge' })).toBeVisible();
  await expect(page.getByText('Diese Organisation wurde gelöscht', { exact: true })).toHaveCount(0);
});
