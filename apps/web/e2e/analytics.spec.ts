import { expect, test } from '@playwright/test';

import { DEMO_WORKSPACE, signInDemo } from './demo';

// Guide step 5.5 end to end on the demo seed (`pnpm db:seed`, 90 days of analytics): the dashboard
// shows the KPIs, the analytics page renders every view, keeps its filters in the URL and shows
// "n. v." where no platform reports a value, the charts have their tables, the detail pages show
// the history of a post and an account, and the export is a CSV. A viewer does all of it, and the
// test only reads, so it can run again on the same seed.

test('the analytics of the demo workspace', async ({ page }) => {
  await signInDemo(page, 'viewer@demo.local');

  const summary = page.getByRole('region', { name: 'Kennzahlen' });
  await expect(page.getByRole('heading', { name: 'Kennzahlen der letzten 30 Tage' })).toBeVisible();
  await expect(summary.getByRole('group', { name: 'Impressions' })).toContainText(/\d/);
  await page.getByRole('link', { name: 'Zu Analytics' }).click();

  await expect(page).toHaveURL(new RegExp(`${DEMO_WORKSPACE}/analytics$`));
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  const kpis = page.getByRole('region', { name: 'Kennzahlen' });
  for (const name of [
    'Impressions',
    'Reichweite',
    'Engagements',
    'Engagement-Rate',
    'Follower-Zuwachs',
    'Veröffentlichte Posts',
  ]) {
    await expect(kpis.getByRole('group', { name, exact: true })).toBeVisible();
  }
  await expect(kpis.getByRole('group', { name: 'Impressions' })).toContainText('ggü. Vorzeitraum');

  // The line chart per platform, its legend, and the same numbers as a table.
  const timeline = page.getByRole('region', { name: 'Verlauf nach Plattform' });
  await expect(timeline.getByRole('img', { name: 'Verlauf nach Plattform: Impressions' })).toBeVisible();
  const legend = timeline.getByRole('list', { name: 'Legende' });
  for (const platform of ['LinkedIn', 'Instagram', 'Facebook', 'X']) {
    await expect(legend.getByText(platform, { exact: true })).toBeVisible();
  }
  await timeline.getByText('Als Tabelle anzeigen').click();
  const table = timeline.getByRole('table', { name: 'Verlauf nach Plattform: Impressions' });
  await expect(table.getByRole('columnheader', { name: 'LinkedIn' })).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(31);

  await expect(page.getByRole('region', { name: 'Plattformvergleich' }).getByText('Facebook')).toBeVisible();
  const topPosts = page.getByRole('region', { name: 'Top-Posts' });
  await expect(topPosts.getByRole('row')).toHaveCount(11);
  const breakdown = page.getByRole('region', { name: 'Auswertung nach Post-Stil' });
  await expect(breakdown.getByRole('cell', { name: 'Storytelling' })).toBeVisible();
  await breakdown.getByRole('button', { name: 'Wochentag' }).click();
  await expect(page).toHaveURL(/by=weekday/);
  await expect(page.getByRole('region', { name: 'Auswertung nach Wochentag' }).getByRole('row')).toHaveCount(
    8,
  );

  // The period and the platforms live in the URL; X reports no reach, which reads "n. v.", not 0.
  await page.getByRole('button', { name: '90 Tage' }).click();
  await expect(page).toHaveURL(/period=90/);
  await page
    .getByRole('group', { name: 'Plattformen' })
    .getByRole('button', { name: 'X', exact: true })
    .click();
  await expect(page).toHaveURL(/platform=X/);
  await expect(kpis.getByRole('group', { name: 'Reichweite' })).toContainText('n. v.');
  await expect(kpis.getByRole('group', { name: 'Impressions' })).not.toContainText('n. v.');
  await page.reload();
  await expect(page.getByRole('button', { name: '90 Tage' })).toHaveAttribute('aria-pressed', 'true');
  await expect(kpis.getByRole('group', { name: 'Reichweite' })).toContainText('n. v.');

  // The export of the period as CSV.
  const href = await page.getByRole('link', { name: 'CSV exportieren' }).getAttribute('href');
  expect(href).toMatch(/export\.csv\?.*platform=X/);
  const csv = await page.request.get(href ?? '');
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect((await csv.text()).split('\n')[0]).toMatch(/^day,platform,account,impressions/);

  // The detail pages: the history of a post and of its account.
  await page.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect(page).toHaveURL(new RegExp(`${DEMO_WORKSPACE}/analytics\\?by=weekday$`));
  await topPosts.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/analytics\/posts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Post-Analytics' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Letzte Abfrage' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Verlauf der Abfragen: Impressions' })).toBeVisible();
  await expect(page.getByText(/^nach \d+ (Stunden?|Tagen?)$/).first()).toBeAttached();

  await page.goBack();
  await topPosts.getByRole('link', { name: 'Demo GmbH' }).first().click();
  await expect(page).toHaveURL(/\/analytics\/accounts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Account-Analytics' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Follower pro Tag' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Follower', exact: true })).toContainText(/\d/);
});
