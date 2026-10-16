import { expect, test, type Response } from '@playwright/test';

import { signUpOwner } from './accounts';

// Guide step 2.8, "Fertig, wenn": brief, style, generate with the mock provider, edit, "Kürzer",
// save and reload. The API runs with AI_PROVIDER=mock, whose texts are deterministic.

const run = Date.now().toString(36);
const owner = {
  name: 'Clara Composer',
  email: `composer-${run}@example.test`,
  password: 'composer password 2026',
};

const HOOK = 'Letzte Woche stand unser Team vor einer Frage, die alles verändert hat';
const MIDDLE = 'Wir hätten den bequemen Weg nehmen können.';
const EDIT = 'Danke an alle, die mitgeholfen haben!';

/** The auto-save of a LinkedIn text after "Kürzer": the edit kept, the middle paragraph gone. */
const savesShortenedText = (response: Response): boolean => {
  const request = response.request();
  if (request.method() !== 'PATCH' || !request.url().includes('/variants/')) {
    return false;
  }
  const body = request.postDataJSON() as { text?: unknown };
  return (
    response.ok() && typeof body.text === 'string' && body.text.includes(EDIT) && !body.text.includes(MIDDLE)
  );
};

test('compose a post with the mock AI, refine it and find it again after a reload', async ({ page }) => {
  await signUpOwner(page, owner, `Composer ${run}`);
  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Erstellen' })
    .click();
  await expect(page.getByRole('heading', { name: 'Beitrag erstellen' })).toBeVisible();

  // Brief, style and a second platform.
  await page.getByLabel('Worum geht es?').fill('Die neue Kaffeemaschine in unserem Büro');
  await page.getByRole('combobox', { name: 'Stil' }).click();
  await page.getByRole('option', { name: /^Storytelling/ }).click();
  await expect(page.getByRole('combobox', { name: 'Stil' })).toHaveText('Storytelling');
  await page.getByRole('button', { name: 'X', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveText(['LinkedIn', 'X']);

  // Generate: the mock streams a storytelling text into both variants.
  await page.getByRole('button', { name: 'Generieren' }).click();
  const text = page.getByLabel('Text', { exact: true });
  await expect(text).toHaveValue(new RegExp(`^${HOOK}: Die neue Kaffeemaschine in unserem Büro\\.`));
  await expect(page.getByRole('status').filter({ hasText: 'Die KI schreibt' })).toHaveCount(0);
  await expect(text).toHaveValue(/Erzählen Sie uns davon\.$/);
  await expect(text).toHaveValue(new RegExp(MIDDLE.replace('.', '\\.')));
  await expect(page.getByText('#Geschichten')).toBeVisible();

  // Edit, then "Kürzer": the diff shows the shortened text with the edit, and accepting it saves.
  await text.fill(`${await text.inputValue()} ${EDIT}`);
  await page.getByRole('button', { name: 'Kürzer' }).click();
  const diff = page.getByRole('dialog', { name: 'Vorschlag prüfen' });
  await expect(diff.getByTestId('refine-diff').locator('del')).toContainText(MIDDLE);
  const saved = page.waitForResponse(savesShortenedText);
  await diff.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(diff).toBeHidden();
  await expect(text).toHaveValue(new RegExp(`^${HOOK}`));
  await expect(text).toHaveValue(new RegExp(`${EDIT}$`));
  await expect(text).not.toHaveValue(new RegExp(MIDDLE.replace('.', '\\.')));
  await saved;
  await expect(page.getByTestId('save-status')).toContainText('Gespeichert');

  // Reload: the saved post comes back with its address, style, platforms and text.
  await expect(page).toHaveURL(/\/posts\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Beitrag bearbeiten' })).toBeVisible();
  await expect(page.getByLabel('Worum geht es?')).toHaveValue('Die neue Kaffeemaschine in unserem Büro');
  await expect(page.getByRole('combobox', { name: 'Stil' })).toHaveText('Storytelling');
  await expect(page.getByRole('tab')).toHaveText(['LinkedIn', 'X']);
  await expect(text).toHaveValue(new RegExp(`^${HOOK}`));
  await expect(text).toHaveValue(new RegExp(`${EDIT}$`));
  await expect(text).not.toHaveValue(new RegExp(MIDDLE.replace('.', '\\.')));

  // The post list leads back to it.
  await page
    .getByRole('navigation', { name: 'Hauptnavigation' })
    .getByRole('link', { name: 'Posts' })
    .click();
  await expect(page.getByRole('heading', { name: 'Beiträge' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Die neue Kaffeemaschine in unserem Büro' })).toBeVisible();
  await expect(page.getByText('LinkedIn: Entwurf')).toBeVisible();
});
