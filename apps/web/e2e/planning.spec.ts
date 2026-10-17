import { expect, test, type Page } from '@playwright/test';

import { signUpOwner } from './accounts';

// Guide step 4.11, "Fertig, wenn": with the mock platform, plan a post for the next minutes, see
// it published with the badge updated live, and move another planned post to another day by
// drag and drop in the calendar. The worker runs the roles scheduler and publisher; its tick
// comes every 15 seconds in CI.

const run = Date.now().toString(36);
const owner = {
  name: 'Paula Planer',
  email: `planning-${run}@example.test`,
  password: 'planning password 2026',
};
/** The time zone of a new workspace. */
const ZONE = 'Europe/Berlin';

/** The date and time in the zone after the given seconds, as the inputs take them. */
function localIn(seconds: number): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(Date.now() + seconds * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

const nextDay = (date: string, days: number): string =>
  new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days))
    .toISOString()
    .slice(0, 10);

/** A new LinkedIn post with text, saved by the composer, and its schedule bar. */
async function compose(page: Page, workspace: string, brief: string, text: string) {
  await page.goto(`${workspace}/compose`);
  await page.getByLabel('Worum geht es?').fill(brief);
  // LinkedIn is chosen; once the post has a brief, the auto-save creates it with its variant.
  const editor = page.getByLabel('Text', { exact: true });
  await editor.fill(text);
  const bar = page.getByRole('region', { name: 'Planen' });
  await expect(bar.getByText('Entwurf', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Gespeichert/)).toBeVisible();
  return bar;
}

test('plan a post with the mock platform, see it published live and move another one by drag and drop', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const workspace = await signUpOwner(page, owner, `Planung ${run}`);

  // Connect the mock LinkedIn: the consent, then one of the pages it reaches.
  await page.goto(`${workspace}/accounts`);
  await page.getByRole('button', { name: 'LinkedIn verbinden' }).click();
  await page.getByRole('link', { name: 'Zugriff erlauben' }).click();
  await expect(page.getByRole('heading', { name: 'Accounts auswählen' })).toBeVisible();
  await page.getByRole('checkbox', { name: /Nordlicht Haustechnik/ }).check();
  await page.getByRole('button', { name: 'Verbinden', exact: true }).click();
  await expect(page.getByText('1 Account verbunden.')).toBeVisible();
  await expect(page.getByText('Nordlicht Haustechnik', { exact: true })).toBeVisible();

  // Plan a post one to two minutes ahead, on the account the bar picks.
  const bar = await compose(
    page,
    workspace,
    'Tag der offenen Werkstatt',
    'Am Samstag öffnen wir die Werkstatt.',
  );
  await expect(bar.getByLabel('Account für LinkedIn')).toHaveValue(/.+/);
  const soon = localIn(120);
  await bar.getByLabel('Datum', { exact: true }).fill(soon.date);
  await bar.getByLabel('Uhrzeit', { exact: true }).fill(soon.time);
  await bar.getByRole('button', { name: '1 Variante planen' }).click();
  await expect(page.getByText('1 Variante geplant.')).toBeVisible();
  await expect(bar.getByText('Geplant', { exact: true })).toBeVisible();

  // The scheduler queues it, the mock platform publishes it, and the badge follows without a reload.
  await expect(bar.getByText('Veröffentlicht', { exact: true })).toBeVisible({ timeout: 210_000 });
  await expect(bar.getByRole('link', { name: 'Original ansehen' })).toBeVisible();

  // A second post two days ahead moves to a neighbouring day in the calendar.
  const later = localIn(2 * 86_400).date;
  const second = await compose(page, workspace, 'Wartungstipps', 'Fünf Dinge, die Sie vor dem Frost prüfen.');
  await second.getByLabel('Datum', { exact: true }).fill(later);
  await second.getByLabel('Uhrzeit', { exact: true }).fill('10:00');
  await second.getByRole('button', { name: '1 Variante planen' }).click();
  await expect(page.getByText('1 Variante geplant.')).toBeVisible();

  await page.goto(`${workspace}/calendar`);
  const event = page.getByRole('link', { name: /Fünf Dinge/ });
  await expect(page.locator('[data-day]').first()).toBeVisible();
  if (!(await page.locator(`[data-day="${later}"]`).isVisible())) {
    await page.getByRole('button', { name: 'Nächster Zeitraum' }).click();
  }
  await expect(page.locator(`[data-day="${later}"]`).getByRole('link', { name: /Fünf Dinge/ })).toBeVisible();
  // The day after, or the day before when the month ends with the day of the post.
  const after = nextDay(later, 1);
  const target = (await page.locator(`[data-day="${after}"]`).count()) > 0 ? after : nextDay(later, -1);

  // Centered, so the drag stays clear of the edges where the page scrolls by itself.
  await page.locator(`[data-day="${target}"]`).evaluate((cell) => {
    cell.scrollIntoView({ block: 'center' });
  });
  const from = await event.boundingBox();
  const to = await page.locator(`[data-day="${target}"]`).boundingBox();
  if (!from || !to) {
    throw new Error('the event or the target day is not on the screen');
  }
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByText(/^Umgeplant auf/)).toBeVisible();
  await expect(
    page.locator(`[data-day="${target}"]`).getByRole('link', { name: /Fünf Dinge/ }),
  ).toBeVisible();

  // The server keeps the new day.
  await page.reload();
  await expect(page.locator('[data-day]').first()).toBeVisible();
  if (!(await page.locator(`[data-day="${target}"]`).isVisible())) {
    await page.getByRole('button', { name: 'Nächster Zeitraum' }).click();
  }
  await expect(
    page.locator(`[data-day="${target}"]`).getByRole('link', { name: /Fünf Dinge/ }),
  ).toBeVisible();
});
