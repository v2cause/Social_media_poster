import type { Page } from 'playwright';

import { FlowError } from '../flow-error';
import { errorsOf, isGone } from './answers';
import { answerTo, find, open, type FlowContext } from './kit';

/**
 * Deletes a post through its menu (guide step 6.3). The answer to DeleteTweet decides; a post
 * that is already gone counts as deleted.
 */
export async function deletePost(
  page: Page,
  ctx: FlowContext,
  input: { handle: string | null; externalPostId: string },
): Promise<void> {
  const map = ctx.selectors;
  await open(page, ctx, `/${input.handle ?? 'i'}/status/${input.externalPostId}`);
  // The first menu of a status page belongs to the post itself, the others to replies.
  const menu = await find(page, ctx, 'post.menu', map.post.menu);
  await menu.click();
  const item = await find(page, ctx, 'post.delete', map.post.delete);
  await item.click();
  const confirm = await find(page, ctx, 'post.confirmDelete', map.post.confirmDelete);
  const answer = await answerTo(page, ctx, 'deletePost', () => confirm.click());
  if (answer === null) {
    throw new FlowError('OUTCOME_UNKNOWN', 'X did not answer the deletion in time.');
  }
  if (errorsOf(answer).length > 0 && !isGone(answer)) {
    throw new FlowError('TRANSIENT', 'X refused the deletion.');
  }
}
