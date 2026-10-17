import { expect, test, type Browser, type Page } from '@playwright/test';

import { DEMO_WORKSPACE, seedPassword, signInDemo } from './demo';

// Guide step 6.1 in the browser: the platform admin allows the demo organization, the owner
// switches X without the API on with the risk text, the checkbox and the password, the kill
// switch closes it for every workspace, and the owner switches it off again. Needs the stack
// with FEATURE_X_BROWSER_GLOBAL=true and the demo seed.

async function signInPlatformAdmin(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('platform@demo.local');
  await page.getByLabel('Passwort').fill(seedPassword());
  await page.getByRole('button', { name: 'Anmelden' }).click();
  // Without a membership the app offers the onboarding; the admin page is reached directly.
  await page.waitForURL(/\/onboarding/);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Plattform-Administration' })).toBeVisible();
  return page;
}

test('switch X without the API on, stop it with the kill switch and switch it off again', async ({
  page,
  browser,
}) => {
  const admin = await signInPlatformAdmin(browser);
  await admin.getByLabel('Slug eines Workspace der Organisation').fill('demo');
  await admin.getByRole('button', { name: 'Freischalten' }).click();
  const organizations = admin.getByRole('region', { name: 'X ohne API' });
  await expect(organizations.getByText('Demo GmbH')).toBeVisible();

  await signInDemo(page, 'owner@demo.local');
  await page.goto(`${DEMO_WORKSPACE}/settings`);
  const section = page.getByRole('region', { name: /X ohne API \(experimentell\)/ });
  await expect(section.getByText('Verstoß gegen die Nutzungsbedingungen:')).toBeVisible();
  const enable = section.getByRole('button', { name: 'Einschalten' });
  await expect(enable).toBeDisabled();
  await section.getByLabel('Ich habe die Risiken verstanden').check();
  await section.getByLabel('Passwort', { exact: true }).fill(seedPassword());
  await enable.click();
  await expect(section.getByText('X ohne API ist eingeschaltet.').first()).toBeVisible();
  await expect(section.getByText(/Die Risiken wurden am .* von Demo Owner bestätigt\./)).toBeVisible();

  await admin.getByRole('button', { name: 'Kill-Switch aktivieren' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Kill-Switch aktivieren' }).click();
  await expect(admin.getByText('Aktiv', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    section.getByText('X ohne API ist für alle Workspaces vorübergehend abgeschaltet.'),
  ).toBeVisible();

  await admin.getByRole('button', { name: 'Kill-Switch aufheben' }).click();
  await expect(admin.getByText('Nicht aktiv', { exact: true })).toBeVisible();
  await page.reload();
  await section.getByRole('button', { name: 'Ausschalten' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ausschalten' }).click();
  await expect(section.getByText('Ausgeschaltet', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Einschalten' })).toBeVisible();

  await admin.getByRole('button', { name: 'Freischaltung von Demo GmbH entfernen' }).click();
  await expect(admin.getByText('Noch keine Organisation ist freigeschaltet.')).toBeVisible();
});
