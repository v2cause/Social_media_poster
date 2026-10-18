import { expect, test, type Page } from '@playwright/test';

import { signUpOwner } from './accounts';

// Guide step 2.9, "Fertig, wenn": an idea opens a prefilled composer with one click. On the way
// the owner creates a brand voice (test and version history), sorts custom styles and works
// through the ideas the mock provider suggests.

const run = Date.now().toString(36);
const owner = { name: 'Bruno Brand', email: `brand-${run}@example.test`, password: 'voices and ideas 2026' };

const QUESTIONS = 'Drei Fragen, die uns Kunden am häufigsten stellen';
const BACKSTAGE = 'Ein Blick hinter die Kulissen';

const navigation = (page: Page) => page.getByRole('navigation', { name: 'Hauptnavigation' });
const ideaCard = (page: Page, title: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title }) });

async function addTerm(page: Page, label: string, term: string) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(term);
  await input.press('Enter');
}

async function createStyle(page: Page, name: string, instructions: string) {
  await page.getByRole('button', { name: 'Neuer Stil' }).click();
  const dialog = page.getByRole('dialog', { name: 'Neuer Stil' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Anweisungen').fill(instructions);
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toBeHidden();
}

test('brand voice, custom styles and an idea that opens a prefilled composer', async ({ page }) => {
  await signUpOwner(page, owner, `Brand ${run}`);

  // A brand voice: the first one becomes the default; testing and editing it.
  await navigation(page).getByRole('link', { name: 'Brand Voices' }).click();
  await expect(page.getByRole('heading', { name: 'Brand Voices', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Neue Brand Voice' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Klar und nahbar');
  await addTerm(page, 'Ton', 'freundlich');
  await addTerm(page, 'Verbotene Wörter', 'billig');
  await page.getByLabel('Do', { exact: true }).fill('Konkrete Beispiele nennen\nLeser direkt ansprechen');
  await page
    .getByLabel('Beispiel 1', { exact: true })
    .fill('Heute haben wir unsere neue Werkstatt eröffnet.');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page).toHaveURL(/\/brand-voices\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Klar und nahbar', level: 1 })).toBeVisible();
  await expect(page.getByText('Standard', { exact: true })).toBeVisible();
  await expect(page.locator('summary', { hasText: 'Version 1' })).toBeVisible();

  await page.getByRole('button', { name: 'Stimme testen' }).click();
  await expect(page.getByTestId('voice-test-result')).toContainText('Beispielpost für LinkedIn');

  await page.getByLabel('Beschreibung').fill('Software für Handwerksbetriebe.');
  await expect(page.getByText('Speichern Sie die Änderungen, um sie zu testen.')).toBeVisible();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('summary', { hasText: 'Version 2' })).toBeVisible();
  await expect(page.locator('summary', { hasText: 'Version 2' })).toContainText('Aktuell');

  // Custom styles: two new ones, sorted with the arrows and by drag and drop, one inactive.
  await page.getByRole('link', { name: 'Zurück zu den Brand Voices' }).click();
  await createStyle(page, 'Kurz und knapp', 'Höchstens drei Sätze mit einer klaren Aussage.');
  await createStyle(page, 'Mit Augenzwinkern', 'Locker und mit einer Prise Humor, ohne albern zu werden.');
  const styles = page.getByRole('list', { name: 'Eigene Stile in ihrer Reihenfolge' }).getByRole('listitem');
  await expect(styles).toHaveText([/^Kurz und knapp/, /^Mit Augenzwinkern/]);
  await page.getByRole('button', { name: 'Mit Augenzwinkern nach oben' }).click();
  await expect(styles).toHaveText([/^Mit Augenzwinkern/, /^Kurz und knapp/]);
  await styles.nth(1).dragTo(styles.nth(0));
  await expect(styles).toHaveText([/^Kurz und knapp/, /^Mit Augenzwinkern/]);
  await styles.filter({ hasText: 'Kurz und knapp' }).getByLabel('Aktiv').uncheck();
  await expect(styles.filter({ hasText: 'Kurz und knapp' })).toContainText('Inaktiv');
  await page.reload();
  await expect(styles).toHaveText([/^Kurz und knapp/, /^Mit Augenzwinkern/]);

  // Ideas from the mock provider: save one, discard one.
  await navigation(page).getByRole('link', { name: 'Ideen' }).click();
  await expect(page.getByRole('heading', { name: 'Ideen', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Ideen generieren' }).click();
  await expect(ideaCard(page, QUESTIONS)).toBeVisible();
  await ideaCard(page, BACKSTAGE).getByRole('button', { name: 'Speichern' }).click();
  await expect(ideaCard(page, BACKSTAGE)).toContainText('Gespeichert');
  const discarded = ideaCard(page, BACKSTAGE).getByRole('button', { name: 'Verwerfen' });
  await discarded.click();
  await expect(ideaCard(page, BACKSTAGE)).toHaveCount(0);
  await page.getByRole('button', { name: 'Verworfen', exact: true }).click();
  await expect(ideaCard(page, BACKSTAGE)).toBeVisible();
  await page.getByRole('button', { name: 'Offen', exact: true }).click();

  // One click opens the composer with brief, platforms, style and voice from the idea.
  await ideaCard(page, QUESTIONS).getByRole('link', { name: 'Post erstellen' }).click();
  await expect(page.getByRole('heading', { name: 'Beitrag erstellen' })).toBeVisible();
  await expect(page.getByLabel('Worum geht es?')).toHaveValue(
    new RegExp(`^${QUESTIONS}\\n\\nDie häufigsten Kundenfragen offen und konkret beantworten\\.`),
  );
  await expect(page.getByRole('button', { name: 'LinkedIn' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Facebook' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Instagram' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('combobox', { name: 'Stil' })).toHaveText('Lehrreich');
  await expect(page.getByLabel('Brand Voice').locator('option:checked')).toHaveText('Klar und nahbar');

  // Only active custom styles are offered.
  await page.getByRole('combobox', { name: 'Stil' }).click();
  await expect(page.getByRole('option', { name: /^Mit Augenzwinkern/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Kurz und knapp/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Generating saves the post, which uses the idea up.
  await page.getByRole('button', { name: 'Generieren' }).click();
  await expect(page.getByLabel('Text', { exact: true })).not.toHaveValue('');
  await expect(page).toHaveURL(/\/posts\/[0-9a-f-]{36}$/);
  await navigation(page).getByRole('link', { name: 'Ideen' }).click();
  await expect(page.getByRole('heading', { name: 'Ideen', level: 1 })).toBeVisible();
  await expect(ideaCard(page, BACKSTAGE)).toHaveCount(0);
  await expect(ideaCard(page, QUESTIONS)).toHaveCount(0);
  await page.getByRole('button', { name: 'Verwendet', exact: true }).click();
  await expect(ideaCard(page, QUESTIONS)).toBeVisible();
});
