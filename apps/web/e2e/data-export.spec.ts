import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { readZip } from '@smp/testing';

import { signUpOwner, type Person } from './accounts';
import { linkFromEmail } from './mailpit';

// Guide step 8.1 through the web app, the API and the worker role "gdpr": a new owner asks for an
// export on the data page, the page follows it until it is ready, the owner gets the email with
// the link to the data page and downloads the archive, which holds every table of the
// organization and a manifest. Needs the stack with "gdpr" in WORKER_ROLES. With E2E_SHOTS_DIR
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

test('the owner exports the organization and downloads the archive', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const owner: Person = {
    name: 'Dora Daten',
    email: `data-${stamp}@e2e.test`,
    password: 'a-long-password-for-the-data-export',
  };
  await signUpOwner(page, owner, `Daten ${stamp}`);

  await page.getByRole('button', { name: `Konto von ${owner.name}` }).click();
  await page.getByRole('menuitem', { name: 'Team' }).click();
  await expect(page).toHaveURL(/\/org\/[0-9a-f-]+\/members$/);
  const organizationId = /\/org\/([0-9a-f-]+)\/members/.exec(page.url())?.[1] ?? '';
  await page.getByRole('link', { name: 'Daten und Löschung' }).click();
  await expect(page).toHaveURL(new RegExp(`/org/${organizationId}/data$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Daten und Löschung' })).toBeVisible();
  await expect(page.getByText('Noch keine Exporte.')).toBeVisible();
  await shot(page, 'data-empty');

  await page.getByRole('button', { name: 'Export anfordern' }).click();
  await expect(page.getByText('Der Export wurde angefordert.')).toBeVisible();
  // The role "gdpr" writes the archive; the page asks again until it can be downloaded.
  const download = page.getByRole('button', { name: 'Herunterladen' });
  await expect(download).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('cell', { name: 'Bereit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export anfordern' })).toBeEnabled();
  await shot(page, 'data-ready');

  const mail = await linkFromEmail(owner.email, /http:\/\/\S+\/org\/[0-9a-f-]+\/data/);
  expect(mail.subject).toBe(`Der Datenexport von Daten ${stamp} GmbH ist bereit`);
  expect(mail.url).toBe(`http://localhost:3000/org/${organizationId}/data`);

  const saved = page.waitForEvent('download');
  await download.click();
  const file = await saved;
  expect(file.suggestedFilename()).toMatch(/^social-media-poster-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const archive = readZip(await readFile(await file.path()));
  const entry = (name: string) => archive.find((item) => item.name === name)?.data.toString('utf8') ?? '';
  const manifest = JSON.parse(entry('manifest.json')) as {
    organization: { id: string; name: string };
    tables: Record<string, number>;
  };
  expect(manifest.organization).toEqual({ id: organizationId, name: `Daten ${stamp} GmbH` });
  expect(manifest.tables).toMatchObject({ organization: 1, workspace: 1, membership: 1, users: 1 });
  expect(JSON.parse(entry('data/users.json'))).toEqual([expect.objectContaining({ email: owner.email })]);
  expect(entry('README.txt')).toContain('Secrets such as the tokens');
});
