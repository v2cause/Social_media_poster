import type { Page } from 'playwright';

import { drift, FlowError } from '../flow-error';
import type { XPostCounts } from '../protocol';
import { countsOf, isGone, postIn, userIn } from './answers';
import { answerTo, open, type FlowContext } from './kit';

// The metrics of posts and accounts (guide step 6.3), read from the JSON answers the pages of the
// web app ask for, never from the counters on the page.

export type PostMetricsItem =
  | { kind: 'metrics'; externalPostId: string; counts: XPostCounts; raw: unknown }
  | { kind: 'deleted'; externalPostId: string };

/** The counters of each post, from the answer its page asks for; a post that is gone says so. */
export async function postMetrics(
  page: Page,
  ctx: FlowContext,
  input: { handle: string | null; externalPostIds: readonly string[] },
): Promise<PostMetricsItem[]> {
  const items: PostMetricsItem[] = [];
  for (const id of input.externalPostIds) {
    const path = `/${input.handle ?? 'i'}/status/${id}`;
    const answer = await answerTo(page, ctx, 'postDetail', () => open(page, ctx, path));
    if (answer === null) {
      throw drift('network.postDetail', 'The post sent no details.');
    }
    const post = postIn(answer, id);
    if (post) {
      items.push({ kind: 'metrics', externalPostId: id, counts: countsOf(post), raw: post });
    } else if (isGone(answer)) {
      items.push({ kind: 'deleted', externalPostId: id });
    } else {
      throw drift('network.postDetail', 'The answer network.postDetail has no post.');
    }
  }
  return items;
}

/** The followers of the account, from the answer its profile asks for. */
export async function accountMetrics(
  page: Page,
  ctx: FlowContext,
  input: { handle: string | null },
): Promise<{ followers: number | null; raw: unknown }> {
  if (input.handle === null) {
    throw new FlowError('VALIDATION_REJECTED', 'The account has no handle to open its profile.');
  }
  const { handle } = input;
  const answer = await answerTo(page, ctx, 'userByScreenName', () => open(page, ctx, `/${handle}`));
  const user = answer === null ? null : userIn(answer, { handle });
  if (!user) {
    throw drift('network.userByScreenName', 'The profile sent no user.');
  }
  return { followers: user.followers, raw: { id: user.id, followers: user.followers } };
}
