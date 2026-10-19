import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

// axe against WCAG 2.2 AA for the end-to-end tests (guide step 8.8, architecture 11). A serious
// or critical violation fails the test; every violation goes into the report as an attachment.

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING = new Set(['serious', 'critical']);

export async function expectAccessible(
  page: Page,
  testInfo: TestInfo,
  name: string,
  skipRules: string[] = [],
) {
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
