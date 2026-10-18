import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';
import type { FakeStripe } from '@smp/testing';

import { signUpOwner, type Person } from './accounts';
import { linkFromEmail } from './mailpit';
import { startStripeStandIn, stripeSettings } from './stripe-stand-in';

// Guide step 7.5, "Fertig, wenn": upgrade, downgrade, past_due and cancellation through the web
// app, the API, the worker role "billing" and the fake Stripe. A new owner buys Pro in the hosted
// checkout, opens a second workspace and switches down to Starter, which asks to reduce the
// workspaces; then Stripe reports a failed renewal, which emails the owner and starts the grace
// period, and the end of the subscription, which makes the organization read-only. The run against
// the test clocks of the real Stripe is tools/stripe-test-clock.ts and needs a test key.
//
// Needs the stack with STRIPE_SECRET_KEY (a test key), STRIPE_WEBHOOK_SECRET, STRIPE_API_BASE and
// the worker role "billing"; the fake listens on the port of STRIPE_API_BASE while the test runs.
// With E2E_SHOTS_DIR the test keeps screenshots of the states it passes.

const settings = stripeSettings();
const shots = process.env['E2E_SHOTS_DIR'];

test.skip(settings === null, 'The stack runs without the fake Stripe (STRIPE_SECRET_KEY, STRIPE_API_BASE).');

let fake: FakeStripe | undefined;

test.beforeAll(async () => {
  if (settings) {
    fake = await startStripeStandIn(settings);
  }
});

test.afterAll(async () => {
  await fake?.close();
});

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

/** Reloads until the webhooks of Stripe went through the role "billing" and the page shows it. */
async function reloadUntilVisible(page: Page, locator: Locator) {
  await expect(async () => {
    await page.reload();
    await expect(locator).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000, intervals: [1_000] });
}

test('upgrade, downgrade, a failed renewal and the cancellation reach the billing page', async ({ page }) => {
  const started = fake;
  if (!started) {
    throw new Error('The fake Stripe did not start.');
  }
  const stamp = Date.now().toString(36);
  const owner: Person = {
    name: 'Bea Billing',
    email: `billing-${stamp}@e2e.test`,
    password: 'a-long-password-for-the-invoices',
  };
  await signUpOwner(page, owner, `Abrechnung ${stamp}`);

  // The trial: everything counted, the paid plans with their prices.
  await page.getByRole('button', { name: `Konto von ${owner.name}` }).click();
  await page.getByRole('menuitem', { name: 'Abrechnung' }).click();
  await expect(page).toHaveURL(/\/org\/[0-9a-f-]+\/billing$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Abrechnung' })).toBeVisible();
  const organizationId = /\/org\/([0-9a-f-]+)\/billing/.exec(page.url())?.[1] ?? '';
  await expect(page.getByRole('heading', { level: 2, name: 'Testphase' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Workspaces' })).toHaveAttribute(
    'aria-valuetext',
    '1 von 1',
  );
  await expect(page.getByText(/^49,00\s€ pro Monat$/)).toBeVisible();
  await shot(page, 'billing-trial');

  // Upgrade: the hosted checkout of Pro, paid; the plan follows with the webhooks.
  await page.getByRole('button', { name: 'Tarif wählen: Pro' }).click();
  await expect(page.getByRole('heading', { name: 'Fake Stripe Checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page).toHaveURL(new RegExp(`/org/${organizationId}/billing\\?checkout=success$`));
  await expect(page.getByRole('heading', { level: 2, name: 'Pro' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Aktiv', { exact: true })).toBeVisible();
  const invoices = page.getByRole('table');
  await expect(invoices.getByRole('row').filter({ hasText: 'FAKE-0001' })).toContainText('Bezahlt');

  // The customer portal of Stripe and the way back.
  await page.getByRole('button', { name: 'Verwalten' }).click();
  await expect(page.getByRole('heading', { name: 'Fake Stripe Portal' })).toBeVisible();
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Pro' })).toBeVisible();

  // Pro allows three workspaces; a second one is opened.
  const created = await page.request.post(`/api/org/${organizationId}/workspaces`, {
    data: { name: `Zweiter ${stamp}`, timezone: 'Europe/Berlin', contentLanguage: 'de' },
  });
  expect(created.status()).toBe(201);
  await page.reload();
  await expect(page.getByRole('progressbar', { name: 'Workspaces' })).toHaveAttribute(
    'aria-valuetext',
    '2 von 3',
  );

  // Downgrade: the change in place names what Starter would have too many of.
  await page.getByRole('button', { name: 'Wechseln: Starter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Zu Starter wechseln?' });
  await expect(dialog.getByText('Workspaces: 2 von 1')).toBeVisible();
  // Starter keeps 90 days of analytics instead of the 365 of Pro.
  await expect(dialog.getByText(/^Der neue Tarif bewahrt Analytics 90 Tage auf\./)).toBeVisible();
  await shot(page, 'billing-downgrade-dialog');
  await dialog.getByRole('button', { name: 'Wechseln' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Starter' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('progressbar', { name: 'Workspaces' })).toHaveAttribute(
    'aria-valuetext',
    '2 von 1',
  );
  await expect(page.getByText(/Reduzieren Sie auf 1 oder wählen Sie einen größeren Tarif/)).toBeVisible();
  await shot(page, 'billing-downgraded');

  // past_due: the renewal fails, the owner hears of it and has seven days.
  const [subscriptionId] = [...started.subscriptions.keys()];
  await started.setSubscriptionStatus(String(subscriptionId), 'past_due');
  await reloadUntilVisible(page, page.getByText('Die letzte Zahlung ist fehlgeschlagen'));
  await expect(page.getByText('Zahlung ausstehend', { exact: true })).toBeVisible();
  const email = await linkFromEmail(owner.email, /http:\/\/\S+\/org\/[0-9a-f-]+\/billing/);
  expect(email.subject).toBe(`Die Zahlung für Abrechnung ${stamp} GmbH ist fehlgeschlagen`);
  expect(new URL(email.url).pathname).toBe(`/org/${organizationId}/billing`);
  await shot(page, 'billing-past-due');
  // Every page of the organization shows it.
  await page.goto(`/org/${organizationId}/members`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Die letzte Zahlung ist fehlgeschlagen.' }),
  ).toBeVisible();

  // Cancellation: read-only at once, the plans can be bought again.
  await started.cancelSubscription(String(subscriptionId));
  await reloadUntilVisible(
    page,
    page.getByRole('alert').filter({ hasText: 'Ihre Organisation kann nur noch lesen' }),
  );
  await shot(page, 'members-read-only');
  const refused = await page.request.post(`/api/org/${organizationId}/workspaces`, {
    data: { name: `Dritter ${stamp}`, timezone: 'Europe/Berlin', contentLanguage: 'de' },
  });
  expect(refused.status()).toBe(402);
  expect(await refused.json()).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
  await page.getByRole('link', { name: 'Zur Abrechnung' }).click();
  await expect(page.getByText('Ihre Organisation kann nur noch lesen', { exact: true })).toBeVisible();
  await expect(page.getByText('Beendet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tarif wählen: Pro' })).toBeEnabled();
  await shot(page, 'billing-read-only');
});
