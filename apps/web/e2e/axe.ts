import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

// axe against WCAG 2.2 AA for the end-to-end tests (guide step 8.8, architecture 11). A serious
// or critical violation fails the test; every violation goes into the report as an attachment.

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING = new Set(['serious', 'critical']);

/**
 * Waits for the running transitions and animations that end. axe measures the colors of the
 * moment: right after a switch of the color scheme it saw the colors of a button half way through
 * its transition (transition-colors) and reported a contrast that the page never shows at rest.
 * Animations without an end, such as a spinner, are left alone.
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const ending = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity,
      );
    await Promise.all(ending.map((animation) => animation.finished.catch(() => undefined)));
  });
}

export async function expectAccessible(
  page: Page,
  testInfo: TestInfo,
  name: string,
  skipRules: string[] = [],
) {
  await settled(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).disableRules(skipRules).analyze();
  await testInfo.attach(`axe ${name}`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  });
  const blocking = results.violations
    .filter((violation) => BLOCKING.has(violation.impact ?? ''))
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? ''}): ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    );
  // Soft, so that one run reports the violations of every page.
  expect.soft(blocking, `serious or critical violations on ${name}`).toEqual([]);
}
