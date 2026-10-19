import { expect, type Page } from '@playwright/test';

import { linkFromEmail } from './mailpit';

// Accounts for the end-to-end tests: sign-up through the form, verification through Mailpit, the
// sign-in after it and the onboarding of an owner (guide steps 1.9 and 8.4).

export interface Person {
  name: string;
  email: string;
  password: string;
}

export async function signUp(page: Page, person: Person) {
  await page.getByLabel('Name').fill(person.name);
  await page.getByLabel('E-Mail-Adresse').fill(person.email);
  await page.getByLabel('Passwort').fill(person.password);
  await page.getByRole('button', { name: 'Registrieren' }).click();
  await expect(page.getByRole('heading', { name: 'E-Mail bestätigen' })).toBeVisible();
}

/** After the verification link: the sign-in shows that the address is verified; sign in there. */
export async function signInAfterVerification(page: Page, person: Person) {
  await expect(page).toHaveURL(/\/login\?/);
  await expect(page.getByText('Ihre E-Mail-Adresse ist bestätigt. Melden Sie sich jetzt an.')).toBeVisible();
  await page.getByLabel('E-Mail-Adresse').fill(person.email);
  await page.getByLabel('Passwort').fill(person.password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
}

/** A verified owner with an organization and a workspace; returns the path of the workspace. */
export async function signUpOwner(page: Page, person: Person, workspaceName: string): Promise<string> {
  await page.goto('/signup');
  await signUp(page, person);
  const verification = await linkFromEmail(person.email, /https?:\/\/\S+\/api\/auth\/verify-email\S+/);
  await page.goto(verification.url);
  await signInAfterVerification(page, person);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Name der Organisation').fill(`${workspaceName} GmbH`);
  await page.getByRole('button', { name: 'Workspace' }).click();
  await page.getByLabel('Name des Workspace').fill(workspaceName);
  await page.getByRole('button', { name: 'Workspace anlegen' }).click();
  await expect(page.getByRole('heading', { name: 'Alles bereit' })).toBeVisible();
  await page.getByRole('link', { name: 'Zum Dashboard' }).click();
  await expect(page.getByRole('heading', { name: `Willkommen in ${workspaceName}` })).toBeVisible();
  return new URL(page.url()).pathname.replace(/\/dashboard$/, '');
}
