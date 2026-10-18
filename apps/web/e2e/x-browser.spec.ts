import { expect, test, type Browser, type Page } from '@playwright/test';
import { totpCodes } from '@smp/testing';

import { STAND_IN_USER, startBrowserWorkerStandIn } from './browser-worker-stand-in';
import { DEMO_WORKSPACE, seedPassword, signInDemo } from './demo';

// Guide steps 6.1 and 6.4 in the browser: the platform admin allows the demo organization, the
// owner switches X without the API on with the risk text, the checkbox and the password, connects
// an X account through the login dialog with the code of the two-factor login, the kill switch
// closes X without the API for every workspace, and the owner switches it off again. Needs the
// stack with FEATURE_X_BROWSER_GLOBAL=true and the demo seed; a stand-in takes the part of the
// browser worker, which must not run. Guide step 8.4: the switches need a second factor, which
// the platform admin sets up on the security page and turns off again with a code at the end.

const X_PASSWORD = 'the-password-of-the-x-account';
const X_CODE = '482916';

/** Connects an X account through the login dialog; the stand-in plays the browser worker. */
async function connectThroughTheBrowser(page: Page) {
  const standIn = await startBrowserWorkerStandIn({ password: X_PASSWORD, code: X_CODE });
  try {
    await page.goto(`${DEMO_WORKSPACE}/accounts`);
    await page.getByLabel('Browser (experimentell)').check();
    await page.getByRole('button', { name: 'X verbinden' }).click();
    const dialog = page.getByRole('dialog', { name: 'Bei X anmelden' });
    await dialog.getByLabel('Benutzername oder E-Mail-Adresse bei X').fill(STAND_IN_USER.handle);
    await dialog.getByLabel('Passwort bei X').fill(X_PASSWORD);
    await dialog.getByRole('button', { name: 'Bei X anmelden' }).click();

    await expect(dialog.getByText('X fragt nach dem Code der Zwei-Faktor-Anmeldung.')).toBeVisible();
    await dialog.getByLabel('Code', { exact: true }).fill(X_CODE);
    await dialog.getByRole('button', { name: 'Code senden' }).click();
    await expect(page.getByText('Der X-Account ist verbunden.')).toBeVisible();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('listitem').filter({ hasText: `@${STAND_IN_USER.handle}` });
    await expect(row.getByText('Über den Browser')).toBeVisible();
    expect(standIn.logins).toHaveLength(1);
    expect(standIn.logins[0]).toMatchObject({
      passwordInPlain: false,
      codeArrived: true,
      codeInPlain: false,
    });

    // The account leaves again, so the demo stays as it was.
    await row.getByRole('button', { name: 'Trennen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Trennen' }).click();
    await expect(page.getByText(`${STAND_IN_USER.name} ist getrennt.`)).toBeVisible();
  } finally {
    await standIn.close();
  }
}

/** Signs the platform admin in and sets up the second factor the admin page asks for. */
async function signInPlatformAdmin(browser: Browser): Promise<{ admin: Page; nextCode: () => string }> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill('platform@demo.local');
  await page.getByLabel('Passwort').fill(seedPassword());
  await page.getByRole('button', { name: 'Anmelden' }).click();
  // Without a membership the app offers the onboarding; the admin page is reached directly.
  await page.waitForURL(/\/onboarding/);
  await page.goto('/admin');
  await expect(page.getByText('Zweiter Faktor erforderlich')).toBeVisible();

  await page.getByRole('link', { name: 'Zu den Sicherheitseinstellungen' }).click();
  await page.getByRole('button', { name: '2FA einrichten' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Passwort', { exact: true }).fill(seedPassword());
  await dialog.getByRole('button', { name: 'Weiter' }).click();
  const nextCode = totpCodes((await dialog.locator('code').textContent()) ?? '');
  await dialog.getByLabel('Code', { exact: true }).fill(nextCode());
  await dialog.getByRole('button', { name: 'Aktivieren' }).click();
  await expect(page.getByText('Die Zwei-Faktor-Authentifizierung ist aktiv.')).toBeVisible();

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Plattform-Administration' })).toBeVisible();
  return { admin: page, nextCode };
}

/** Turning the second factor off takes the password and a code of it. */
async function turnOffSecondFactor(page: Page, code: string) {
  await page.goto('/account/security');
  await page.getByRole('button', { name: '2FA ausschalten' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Passwort', { exact: true }).fill(seedPassword());
  await dialog.getByLabel('Code aus der App oder Backup-Code').fill(code);
  await dialog.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.getByText('Die Zwei-Faktor-Authentifizierung ist ausgeschaltet.')).toBeVisible();
}

test('switch X without the API on, connect an account, stop it with the kill switch and switch it off', async ({
  page,
  browser,
}) => {
  const { admin, nextCode } = await signInPlatformAdmin(browser);
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

  await connectThroughTheBrowser(page);
  await page.goto(`${DEMO_WORKSPACE}/settings`);

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

  // The demo stays as it was: the platform admin without a second factor.
  await turnOffSecondFactor(admin, nextCode());
});
