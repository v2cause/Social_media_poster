import type { Page } from 'playwright';

import { isFlowError } from '../flow-error';
import type { Selector } from '../selectors/types';
import { find, open, present, type FlowContext } from './kit';

/**
 * The daily canary (guide step 6.5): opens the home page and the composer of the internal test
 * account and names the selectors that match nothing. It posts nothing.
 */
export async function canary(page: Page, ctx: FlowContext): Promise<string[]> {
  const map = ctx.selectors;
  const missing: string[] = [];
  const check = async (name: string, selector: Selector): Promise<void> => {
    try {
      await find(page, ctx, name, selector);
    } catch (error) {
      if (isFlowError(error) && error.code === 'SELECTOR_DRIFT') {
        missing.push(name);
        return;
      }
      throw error;
    }
  };
  await open(page, ctx, map.paths.home);
  await check('session.signedIn', map.session.signedIn);
  await open(page, ctx, map.paths.compose);
  await check('composer.textbox', map.composer.textbox);
  await check('composer.submit', map.composer.submit);
  if (!(await present(page, map.composer.fileInput))) {
    missing.push('composer.fileInput');
  }
  return missing;
}
