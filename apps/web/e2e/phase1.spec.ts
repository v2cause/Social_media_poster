import { expect, test } from '@playwright/test';

import { signInAfterVerification, signUp } from './accounts';
import { linkFromEmail } from './mailpit';

// Guide step 1.9, "Fertig, wenn": sign-up, verification email (Mailpit API), onboarding,
// invitation, acceptance, and the viewer sees no write actions.

const run = Date.now().toString(36);
const owner = { name: 'Olivia Owner', email: `owner-${run}@example.test`, password: 'owner password 2026' };
const viewer = {
  name: 'Victor Viewer',
  email: `viewer-${run}@example.test`,
  password: 'viewer password 2026',
};

test('from sign-up to an invited viewer without write actions', async ({ browser }) => {
  // Owner: sign-up and verification.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto('/signup');
  await signUp(ownerPage, owner);
  const verification = await linkFromEmail(owner.email, /http:\/\/\S+\/api\/auth\/verify-email\S+/);
  expect(verification.subject).toBe('Bestätigen Sie Ihre E-Mail-Adresse');
  await ownerPage.goto(verification.url);
  // The link only verifies; the password signs in (guide step 8.4).
  await signInAfterVerification(ownerPage, owner);
  await expect(ownerPage).toHaveURL(/\/onboarding$/);

  // Onboarding in three steps.
  await ownerPage.getByLabel('Name der Organisation').fill(`E2E GmbH ${run}`);
  await ownerPage.getByRole('button', { name: 'Workspace' }).click();
  await ownerPage.getByLabel('Name des Workspace').fill(`Brand ${run}`);
  await ownerPage.getByLabel('Branche (optional)').fill('Software');
  await ownerPage.getByRole('button', { name: 'Workspace anlegen' }).click();
  await expect(ownerPage.getByRole('heading', { name: 'Alles bereit' })).toBeVisible();
  await ownerPage.getByRole('link', { name: 'Zum Dashboard' }).click();
  await expect(ownerPage.getByRole('heading', { name: `Willkommen in Brand ${run}` })).toBeVisible();
  const workspacePath = new URL(ownerPage.url()).pathname;

  // The owner sees the write actions.
  await expect(
    ownerPage.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: 'Erstellen' }),
  ).toBeVisible();

  // Invitation from the team page.
  await ownerPage.getByRole('button', { name: /Konto von/ }).click();
  await ownerPage.getByRole('menuitem', { name: 'Team' }).click();
  await expect(ownerPage.getByRole('heading', { name: 'Mitglieder' })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Einladen' }).click();
  const dialog = ownerPage.getByRole('dialog');
  await dialog.getByLabel('E-Mail-Adresse').fill(viewer.email);
  await dialog.getByLabel('Rolle').selectOption('VIEWER');
  await dialog.getByRole('button', { name: 'Einladung senden' }).click();
  await expect(ownerPage.getByRole('cell', { name: viewer.email })).toBeVisible();

  // Viewer: invitation email, sign-up from the invite page, verification, acceptance.
  const invitation = await linkFromEmail(viewer.email, /http:\/\/\S+\/invite\/\S+/);
  expect(invitation.subject).toBe(`Einladung zu E2E GmbH ${run}`);
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(invitation.url);
  await expect(viewerPage.getByText('Rolle: Betrachter')).toBeVisible();
  await viewerPage.getByRole('link', { name: 'Konto erstellen' }).click();
  await expect(viewerPage.getByLabel('E-Mail-Adresse')).toHaveValue(viewer.email);
  await signUp(viewerPage, viewer);
  const viewerVerification = await linkFromEmail(viewer.email, /http:\/\/\S+\/api\/auth\/verify-email\S+/);
  await viewerPage.goto(viewerVerification.url);
  await signInAfterVerification(viewerPage, viewer);
  await expect(viewerPage).toHaveURL(/\/invite\//);
  await viewerPage.getByRole('button', { name: 'Einladung annehmen' }).click();
  await expect(viewerPage).toHaveURL(new RegExp(`${workspacePath}$`));
  await expect(viewerPage.getByText('Ihre Rolle: Betrachter')).toBeVisible();

  // The viewer sees no write actions: no "Erstellen", no invite button, no role selects.
  const navigation = viewerPage.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(navigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Erstellen' })).toHaveCount(0);
  await viewerPage.getByRole('button', { name: /Konto von/ }).click();
  await viewerPage.getByRole('menuitem', { name: 'Team' }).click();
  await expect(viewerPage.getByRole('cell', { name: owner.email })).toBeVisible();
  await expect(viewerPage.getByRole('button', { name: 'Einladen' })).toHaveCount(0);
  await expect(viewerPage.getByRole('combobox')).toHaveCount(0);
  await expect(viewerPage.getByRole('button', { name: 'Entfernen' })).toHaveCount(0);
  await expect(viewerPage.getByRole('heading', { name: 'Offene Einladungen' })).toHaveCount(0);

  await ownerContext.close();
  await viewerContext.close();
});
