import type { Page } from 'playwright';

import { drift, FlowError, type FlowErrorCode } from '../flow-error';
import { createdAtOf, errorsOf, postsIn, sameText, userIn } from './answers';
import { answerTo, find, locate, open, present, type FlowContext } from './kit';

// Posting through the composer of the web app (architecture 4.3, guide step 6.3). The id and
// the time of the new post come from the answer to CreateTweet. Once the button is pressed the
// post may be out: without an answer the flow ends with OUTCOME_UNKNOWN, and the publish job
// reconciles before it sends again.

export interface FlowMedia {
  name: string;
  mimeType: string;
  buffer: Buffer;
  altText: string | null;
}

export interface PostRef {
  externalPostId: string;
  externalUrl: string;
  publishedAt: string;
}

/** Codes of X in the answer to a post, and what they mean for the publish job. */
const POST_ERRORS: Readonly<Record<number, FlowErrorCode>> = {
  187: 'DUPLICATE',
  186: 'VALIDATION_REJECTED',
  88: 'RATE_LIMITED',
  185: 'RATE_LIMITED',
  344: 'RATE_LIMITED',
  64: 'CHALLENGE_REQUIRED',
  226: 'CHALLENGE_REQUIRED',
  326: 'CHALLENGE_REQUIRED',
  32: 'AUTH_EXPIRED',
  89: 'AUTH_EXPIRED',
};
const RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;

const linkOf = (ctx: FlowContext, handle: string | null, postId: string): string =>
  `${ctx.selectors.origin}/${handle ?? 'i'}/status/${postId}`;

export async function publish(
  page: Page,
  ctx: FlowContext,
  input: { text: string; media: readonly FlowMedia[]; handle: string | null },
): Promise<PostRef> {
  const map = ctx.selectors;
  await open(page, ctx, map.paths.compose);
  const textbox = await find(page, ctx, 'composer.textbox', map.composer.textbox);
  await textbox.click();
  // Line by line, as the editor of X takes a new line from the Enter key.
  for (const [index, line] of input.text.split('\n').entries()) {
    if (index > 0) {
      await page.keyboard.press('Enter');
    }
    if (line !== '') {
      await page.keyboard.insertText(line);
    }
  }

  if (input.media.length > 0) {
    if (!(await present(page, map.composer.fileInput))) {
      throw drift('composer.fileInput');
    }
    await locate(page, map.composer.fileInput)
      .first()
      .setInputFiles(input.media.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
    for (const [index, file] of input.media.entries()) {
      if (file.altText !== null) {
        await describeImage(page, ctx, index, file.altText);
      }
    }
  }

  const submit = await find(page, ctx, 'composer.submit', map.composer.submit);
  // The button stays disabled while the images upload; nothing is sent until it can be pressed.
  try {
    await submit.click({ trial: true, timeout: ctx.timeoutMs * 2 });
  } catch {
    throw new FlowError('TRANSIENT', 'The post button stayed disabled.');
  }
  const answer = await answerTo(page, ctx, 'createPost', () => submit.click());
  if (answer === null) {
    throw new FlowError('OUTCOME_UNKNOWN', 'X did not answer the post in time.');
  }
  const created = postsIn(answer)[0];
  if (!created) {
    const [error] = errorsOf(answer);
    if (error) {
      const code = POST_ERRORS[error.code] ?? 'TRANSIENT';
      throw new FlowError(
        code,
        `X refused the post (${String(error.code)}).`,
        code === 'RATE_LIMITED' ? { retryAfterMs: RATE_LIMIT_WAIT_MS } : {},
      );
    }
    // The post is likely out, but its answer no longer fits the map.
    throw new FlowError('OUTCOME_UNKNOWN', 'The answer network.createPost has no post.', {
      selector: 'network.createPost',
    });
  }
  const handle = userIn(answer)?.handle ?? input.handle;
  return {
    externalPostId: created.rest_id,
    externalUrl: linkOf(ctx, handle, created.rest_id),
    publishedAt: (createdAtOf(created) ?? ctx.now()).toISOString(),
  };
}

/** Sets the alt text of the image at the index. */
async function describeImage(page: Page, ctx: FlowContext, index: number, altText: string): Promise<void> {
  const selectors = ctx.selectors.composer.altText;
  const opener = locate(page, selectors.open).nth(index);
  try {
    await opener.waitFor({ state: 'visible', timeout: ctx.timeoutMs });
  } catch {
    throw drift('composer.altText.open');
  }
  await opener.click();
  const field = await find(page, ctx, 'composer.altText.input', selectors.input);
  await field.fill(altText);
  const save = await find(page, ctx, 'composer.altText.save', selectors.save);
  await save.click();
}

/**
 * Looks for a post of the account with this text since the time, in the timeline of its
 * profile; null when there is none. It decides whether an unclear post went out.
 */
export async function reconcile(
  page: Page,
  ctx: FlowContext,
  input: { handle: string | null; text: string; since: Date },
): Promise<PostRef | null> {
  if (input.handle === null) {
    throw new FlowError('VALIDATION_REJECTED', 'The account has no handle to look up its posts.');
  }
  const { handle } = input;
  const answer = await answerTo(page, ctx, 'userPosts', () => open(page, ctx, `/${handle}`));
  if (answer === null) {
    throw drift('network.userPosts', 'The profile sent no posts.');
  }
  for (const post of postsIn(answer)) {
    const at = createdAtOf(post);
    if (at && at.getTime() >= input.since.getTime() && sameText(post.legacy.full_text ?? '', input.text)) {
      return {
        externalPostId: post.rest_id,
        externalUrl: linkOf(ctx, handle, post.rest_id),
        publishedAt: at.toISOString(),
      };
    }
  }
  return null;
}
