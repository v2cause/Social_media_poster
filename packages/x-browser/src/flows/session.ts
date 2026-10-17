import type { Page } from 'playwright';

import { drift } from '../flow-error';
import type { XUser } from '../protocol';
import { userIn } from './answers';
import { expectAnswer, find, open, type FlowContext } from './kit';

/**
 * verifySession (guide step 6.3): the user of the signed-in session, from the answer the home
 * page asks for. A session that lands on the login ends with AUTH_EXPIRED, a challenge with
 * CHALLENGE_REQUIRED.
 */
export async function verifySession(page: Page, ctx: FlowContext): Promise<XUser> {
  const map = ctx.selectors;
  const viewer = expectAnswer(page, ctx, 'viewer');
  await open(page, ctx, map.paths.home);
  await find(page, ctx, 'session.signedIn', map.session.signedIn);
  const answer = await viewer.result();
  const user = answer === null ? null : userIn(answer);
  if (!user) {
    throw drift('network.viewer', 'The answer network.viewer has no user.');
  }
  return { id: user.id, handle: user.handle, name: user.name, avatarUrl: user.avatarUrl };
}
