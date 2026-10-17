import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page } from '@playwright/test';

// The demo workspace of `pnpm db:seed` (architecture 16) for the end-to-end tests that read seeded
// data. Its users share the password from SEED_USER_PASSWORD: from the environment, otherwise
// from the root .env that the stack runs with.

export const DEMO_WORKSPACE = '/w/demo';

export function seedPassword(): string {
  const fromEnvironment = process.env['SEED_USER_PASSWORD'];
  if (fromEnvironment) {
    return fromEnvironment;
  }
  const line = readFileSync(resolve(__dirname, '../../../.env'), 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('SEED_USER_PASSWORD='));
  const value = line?.slice('SEED_USER_PASSWORD='.length).trim();
  if (!value) {
    throw new Error('SEED_USER_PASSWORD is neither in the environment nor in the root .env.');
  }
  return value;
}

/** Signs a demo user in and waits for the dashboard of the demo workspace. */
export async function signInDemo(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(seedPassword());
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(new RegExp(`${DEMO_WORKSPACE}/dashboard$`));
}
