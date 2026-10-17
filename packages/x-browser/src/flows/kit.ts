import type { Locator, Page, Response } from 'playwright';

import { drift, FlowError } from '../flow-error';
import type { Selector, SelectorMap } from '../selectors/types';

// What every flow shares (guide step 6.3): locating by the selector map, detectChallenge after
// each navigation, and reading the JSON answers of the web app. A missing selector ends the flow
// with SELECTOR_DRIFT at once, a challenge with CHALLENGE_REQUIRED; no flow guesses, tries
// another selector or tries again.

export interface FlowContext {
  readonly selectors: SelectorMap;
  /** How long one step waits for an element or an answer: 30 seconds in production. */
  readonly timeoutMs: number;
  now(): Date;
}

export type NetworkName = keyof SelectorMap['network'];

export function locate(page: Page, selector: Selector): Locator {
  if ('testId' in selector) {
    return page.getByTestId(selector.testId);
  }
  if ('role' in selector) {
    return selector.name === undefined
      ? page.getByRole(selector.role)
      : page.getByRole(selector.role, { name: selector.name });
  }
  return page.locator(selector.css);
}

const isTimeout = (error: unknown): boolean => error instanceof Error && error.name === 'TimeoutError';

/** True when X shows a challenge: a captcha, a confirmation of the login or a block page. */
export async function detectChallenge(page: Page, map: SelectorMap): Promise<boolean> {
  const url = page.url();
  if (map.challenge.urlPatterns.some((pattern) => pattern.test(url))) {
    return true;
  }
  for (const element of map.challenge.elements) {
    if ((await locate(page, element).count()) > 0) {
      return true;
    }
  }
  return false;
}

export async function assertNoChallenge(page: Page, map: SelectorMap): Promise<void> {
  if (await detectChallenge(page, map)) {
    throw new FlowError('CHALLENGE_REQUIRED', 'X asks for a challenge.');
  }
}

const SIGNED_OUT = [/^\/i\/flow\/login\b/, /^\/login\b/, /^\/i\/flow\/signup\b/, /^\/logout\b/];

/** True when the page shows the login of X instead of a signed-in page. */
export const isSignedOut = (page: Page): boolean =>
  SIGNED_OUT.some((pattern) => pattern.test(new URL(page.url()).pathname));

/** Opens a page of the web app, then checks it for a challenge and, off the login, for a lost session. */
export async function open(page: Page, ctx: FlowContext, path: string): Promise<void> {
  const { selectors } = ctx;
  try {
    await page.goto(`${selectors.origin}${path}`, { waitUntil: 'domcontentloaded', timeout: ctx.timeoutMs });
  } catch (error) {
    throw new FlowError(
      'TRANSIENT',
      isTimeout(error) ? `The page ${path} did not load in time.` : `The page ${path} did not load.`,
    );
  }
  await assertNoChallenge(page, selectors);
  if (path !== selectors.paths.login && isSignedOut(page)) {
    throw new FlowError('AUTH_EXPIRED', 'The session of X is no longer signed in.');
  }
}

/**
 * The element of a selector once it is visible. When it does not appear, a challenge or the login
 * in place of the page say why (the web app redirects on its own, after the page loaded);
 * otherwise the selector drifted.
 */
export async function find(page: Page, ctx: FlowContext, name: string, selector: Selector): Promise<Locator> {
  const locator = locate(page, selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: ctx.timeoutMs });
    return locator;
  } catch (error) {
    if (!isTimeout(error)) {
      throw error;
    }
    await assertNoChallenge(page, ctx.selectors);
    if (isSignedOut(page) && !name.startsWith('login.')) {
      throw new FlowError('AUTH_EXPIRED', 'The session of X is no longer signed in.');
    }
    throw drift(name);
  }
}

/** True when the element of a selector is in the page, without waiting. */
export const present = async (page: Page, selector: Selector): Promise<boolean> =>
  (await locate(page, selector).count()) > 0;

/** When X lets the account try again after a 429, from its headers; 15 minutes without them. */
const retryAfterOf = (headers: Record<string, string>, now: Date): number => {
  const reset = Number(headers['x-rate-limit-reset']);
  const waitMs = Number.isFinite(reset) ? reset * 1000 - now.getTime() : Number.NaN;
  return waitMs > 0 ? Math.min(waitMs, 24 * 60 * 60 * 1000) : 15 * 60 * 1000;
};

/** An answer as it arrived: read at once, before a navigation can drop its body. */
interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

const capture = async (response: Response): Promise<Answer> => ({
  status: response.status(),
  headers: response.headers(),
  body: await response.text().catch(() => null),
});

/** The JSON of an answer; a rate limit, a lost session or an answer that is no JSON end the flow. */
function jsonOf(answer: Answer, ctx: FlowContext, name: NetworkName): unknown {
  if (answer.status === 429) {
    throw new FlowError('RATE_LIMITED', 'X asks the account to wait.', {
      retryAfterMs: retryAfterOf(answer.headers, ctx.now()),
    });
  }
  if (answer.status === 401) {
    throw new FlowError('AUTH_EXPIRED', 'X no longer accepts the session.');
  }
  try {
    return JSON.parse(answer.body ?? '') as unknown;
  } catch {
    throw drift(`network.${name}`, `The answer network.${name} is no JSON.`);
  }
}

/**
 * Waits for the next answer of the name from now on; result() gives its JSON, or null when none
 * came in time. Started before the action that causes the answer, so a fast one is not missed.
 * An answer whose body a navigation took along is skipped for the next one.
 */
export function expectAnswer(
  page: Page,
  ctx: FlowContext,
  name: NetworkName,
): { result(): Promise<unknown> } {
  const pattern = ctx.selectors.network[name];
  let settle: (answer: Answer | null) => void = () => undefined;
  const arrived = new Promise<Answer | null>((resolve) => {
    settle = resolve;
  });
  const finish = (answer: Answer | null): void => {
    clearTimeout(timer);
    page.off('response', listener);
    settle(answer);
  };
  const listener = (response: Response): void => {
    if (pattern.test(response.url())) {
      void capture(response).then((answer) => {
        if (answer.body !== null || answer.status === 429 || answer.status === 401) {
          finish(answer);
        }
      });
    }
  };
  const timer = setTimeout(() => {
    finish(null);
  }, ctx.timeoutMs);
  page.on('response', listener);
  return {
    async result() {
      const answer = await arrived;
      return answer === null ? null : jsonOf(answer, ctx, name);
    },
  };
}

/** Runs an action and returns the JSON of the first answer of the name it causes, or null. */
export async function answerTo(
  page: Page,
  ctx: FlowContext,
  name: NetworkName,
  action: () => Promise<unknown>,
): Promise<unknown> {
  const answer = expectAnswer(page, ctx, name);
  await action();
  return answer.result();
}

/**
 * Every answer of the name from now on, in order, for steps that follow each other quickly (the
 * login): an answer that comes before the flow asks for it waits in the queue.
 */
export function answersOf(page: Page, ctx: FlowContext, name: NetworkName) {
  const pattern = ctx.selectors.network[name];
  const queue: Promise<Answer>[] = [];
  const waiting: ((answer: Promise<Answer>) => void)[] = [];
  const listener = (response: Response): void => {
    if (!pattern.test(response.url())) {
      return;
    }
    const answer = capture(response);
    const next = waiting.shift();
    if (next) {
      next(answer);
    } else {
      queue.push(answer);
    }
  };
  page.on('response', listener);
  return {
    /** The next answer, or null when none comes within the timeout. */
    async next(timeoutMs = ctx.timeoutMs): Promise<unknown> {
      const queued = queue.shift();
      const answer =
        queued ??
        new Promise<Answer | null>((resolve) => {
          const deliver = (arrived: Promise<Answer>): void => {
            clearTimeout(timer);
            resolve(arrived);
          };
          const timer = setTimeout(() => {
            waiting.splice(waiting.indexOf(deliver), 1);
            resolve(null);
          }, timeoutMs);
          waiting.push(deliver);
        });
      const arrived = await answer;
      return arrived === null ? null : jsonOf(arrived, ctx, name);
    },
    stop(): void {
      page.off('response', listener);
    },
  };
}
