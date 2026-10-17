import type { Locator, Page } from 'playwright';

import { drift, FlowError, isFlowError } from '../flow-error';
import type { XUser } from '../protocol';
import { errorsOf, subtaskOf } from './answers';
import { answersOf, assertNoChallenge, find, open, type FlowContext } from './kit';
import { verifySession } from './session';

// The interactive login (guide step 6.4, architecture 4.3). The steps come from the JSON answers
// of the login (onboarding/task.json), not from the page: the flow fills in the user name, the
// password and, when X asks for it, the code of the two-factor login, and stops at every step X
// adds for a login it finds suspicious. Up to three codes are tried; the password is tried once.

const MAX_STEPS = 12;
const MAX_CODES = 3;
/** Codes X answers a wrong user name or password with. */
const WRONG_CREDENTIALS = new Set([32, 399]);

export interface LoginHooks {
  /** X asks for a code of the two-factor login; null when none came in time. */
  code(attempt: number): Promise<string | null>;
}

const fillAndSubmit = async (field: Locator, value: string): Promise<void> => {
  await field.fill(value);
  await field.press('Enter');
};

/** The page went on to the home page: the last answer of the login was success. */
const SIGNED_IN = Symbol('signed in');

export async function login(
  page: Page,
  ctx: FlowContext,
  credentials: { username: string; password: string },
  hooks: LoginHooks,
): Promise<XUser> {
  const map = ctx.selectors;
  const steps = answersOf(page, ctx, 'onboarding');
  // The web app leaves the login right after its last answer, which can take that answer along.
  const nextStep = async (): Promise<unknown> => {
    try {
      return await steps.next();
    } catch (error) {
      const home = await page
        .waitForURL((url) => url.pathname === map.paths.home, { timeout: ctx.timeoutMs })
        .then(
          () => true,
          () => false,
        );
      if (isFlowError(error) && error.code === 'SELECTOR_DRIFT' && home) {
        return SIGNED_IN;
      }
      throw error;
    }
  };
  try {
    await open(page, ctx, map.paths.login);
    let answer = await steps.next();
    let codes = 0;
    let awaitingCode = false;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (answer === SIGNED_IN) {
        return await verifySession(page, ctx);
      }
      if (answer === null) {
        throw drift('network.onboarding', 'The login sent no next step.');
      }
      await assertNoChallenge(page, map);
      const errors = errorsOf(answer);
      let subtask = subtaskOf(answer);
      if (errors.length > 0) {
        if (!awaitingCode) {
          throw errors.some((error) => WRONG_CREDENTIALS.has(error.code))
            ? new FlowError('INVALID_CREDENTIALS', 'X refused the user name or the password.')
            : new FlowError('TRANSIENT', 'X refused the login.');
        }
        // A wrong code: X keeps asking for one.
        subtask = map.onboarding.code[0] ?? null;
      }
      if (subtask === null) {
        throw drift('network.onboarding', 'The answer of the login names no step.');
      }
      awaitingCode = false;
      if (map.onboarding.success.includes(subtask)) {
        return await verifySession(page, ctx);
      }
      if (map.onboarding.challenge.includes(subtask)) {
        throw new FlowError('CHALLENGE_REQUIRED', `X asks for ${subtask}.`);
      }
      if (map.onboarding.passive.includes(subtask)) {
        answer = await nextStep();
      } else if (map.onboarding.username.includes(subtask)) {
        await fillAndSubmit(
          await find(page, ctx, 'login.username', map.login.username),
          credentials.username,
        );
        answer = await nextStep();
      } else if (map.onboarding.password.includes(subtask)) {
        await fillAndSubmit(
          await find(page, ctx, 'login.password', map.login.password),
          credentials.password,
        );
        answer = await nextStep();
      } else if (map.onboarding.code.includes(subtask)) {
        codes += 1;
        if (codes > MAX_CODES) {
          throw new FlowError('INVALID_CODE', 'X refused the codes of the two-factor login.');
        }
        const code = await hooks.code(codes);
        if (code === null) {
          throw new FlowError('TIMEOUT', 'No code of the two-factor login came in time.');
        }
        await fillAndSubmit(await find(page, ctx, 'login.code', map.login.code), code);
        awaitingCode = true;
        answer = await nextStep();
      } else {
        throw drift(`onboarding.${subtask}`.slice(0, 100), `The login step ${subtask} is unknown.`);
      }
    }
    throw drift('network.onboarding', 'The login did not end.');
  } finally {
    steps.stop();
  }
}
