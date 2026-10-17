import type { Logger } from '@smp/observability';
import {
  isFlowError,
  XB_KEYS,
  xbCredentialsSchema,
  xbLoginAad,
  xbSessionAad,
  type LoginHooks,
  type XbCommand,
  type XbCredentials,
  type XbFailure,
  type XbLoginFailureCode,
  type XbOutcome,
  type XbReport,
  type XUser,
} from '@smp/x-browser';
import type Redis from 'ioredis';
import type { Page } from 'playwright';

import type { BrowserHost } from './browser-host';
import type { SessionSealer } from './command-runner';

// The interactive login of X (guide step 6.4, architecture 4.3). The credentials open here only,
// stay in memory for the one flow and reach no log; X asks for a code, the runner reports
// AWAITING_2FA and waits for the code the API pushes sealed to xb:login:{id}:input. On success
// the storage state goes back sealed for the workspace and the X user; every other end goes back
// as the reason of the failure. The whole login ends at the time of its command: the page closes
// then, wherever the flow is. Nothing is tried again; a login that failed is started anew by the
// user.

export interface LoginDependencies {
  host: Pick<BrowserHost, 'run'>;
  sealer: SessionSealer;
  /** The login flow of the selector map. */
  login(page: Page, credentials: XbCredentials, hooks: LoginHooks): Promise<XUser>;
  /** Waits for the next sealed code of the login, at most until the time given. */
  nextCode(loginSessionId: string, until: Date): Promise<Uint8Array | null>;
  report(report: XbReport): Promise<void>;
  killed(): Promise<boolean>;
  now(): Date;
  selectorsVersion: string;
  logger: Pick<Logger, 'info' | 'warn'>;
}

/** The reason of a failure of the flow, as the login reports it. */
const failureOf = (code: string): XbLoginFailureCode => {
  switch (code) {
    case 'INVALID_CREDENTIALS':
    case 'INVALID_CODE':
    case 'CHALLENGE_REQUIRED':
    case 'SELECTOR_DRIFT':
    case 'TIMEOUT':
      return code;
    default:
      return 'TRANSIENT';
  }
};

/** Waits for the codes the API pushes, each wait on a connection of its own, as BLPOP blocks it. */
export function codeInbox(
  redis: Pick<Redis, 'duplicate'>,
  now: () => Date,
): (loginSessionId: string, until: Date) => Promise<Uint8Array | null> {
  return async (loginSessionId, until) => {
    const seconds = (until.getTime() - now().getTime()) / 1_000;
    if (seconds <= 0) {
      return null;
    }
    const connection = redis.duplicate();
    try {
      const popped = await connection.blpop(XB_KEYS.loginInput(loginSessionId), seconds);
      return popped ? new Uint8Array(Buffer.from(popped[1], 'base64')) : null;
    } finally {
      connection.disconnect();
    }
  };
}

export class LoginRunner {
  constructor(private readonly deps: LoginDependencies) {}

  async run(command: XbCommand<'login.start'>): Promise<XbOutcome<'login.start'>> {
    const { deps } = this;
    const scope = {
      organizationId: command.organizationId,
      workspaceId: command.workspaceId,
      loginSessionId: command.loginSessionId,
    };
    const log = { commandId: command.commandId, loginSessionId: command.loginSessionId };
    const fail = async (
      failure: XbLoginFailureCode,
      code: XbFailure['code'],
      message: string,
    ): Promise<XbOutcome<'login.start'>> => {
      await deps.report({ kind: 'login.failed', ...scope, failure });
      deps.logger.warn({ ...log, failure }, 'xb.login.failed');
      return { ok: false, error: { code, message } };
    };

    if (await deps.killed()) {
      return fail('UNAVAILABLE', 'UNAVAILABLE', 'The X browser is switched off.');
    }
    const startedAt = deps.now().getTime();
    const expiresAt = new Date(command.expiresAt);
    if (Date.parse(command.deadline) <= startedAt || expiresAt.getTime() <= startedAt) {
      return fail('UNAVAILABLE', 'EXPIRED', 'The login started after its deadline.');
    }
    let credentials: XbCredentials;
    try {
      credentials = xbCredentialsSchema.parse(
        JSON.parse(
          await deps.sealer.open(
            Buffer.from(command.credentials, 'base64'),
            xbLoginAad(command.workspaceId, command.loginSessionId, 'credentials'),
          ),
        ),
      );
    } catch {
      return fail('TRANSIENT', 'TRANSIENT', 'The credentials of the login do not open.');
    }

    const hooks: LoginHooks = {
      code: async () => {
        await deps.report({ kind: 'login.status', ...scope, status: 'AWAITING_2FA' });
        const sealed = await deps.nextCode(command.loginSessionId, expiresAt);
        return sealed === null
          ? null
          : deps.sealer.open(sealed, xbLoginAad(command.workspaceId, command.loginSessionId, 'code'));
      },
    };
    const expiry = { reached: false };
    const end = await deps.host.run({ storageState: null, locale: command.locale }, async (page) => {
      const timer = setTimeout(() => {
        expiry.reached = true;
        page.close().catch(() => undefined);
      }, expiresAt.getTime() - deps.now().getTime());
      try {
        return await deps.login(page, credentials, hooks);
      } finally {
        clearTimeout(timer);
      }
    });
    const finished = { ...log, durationMs: deps.now().getTime() - startedAt };
    if (end.refusedHosts.length > 0) {
      deps.logger.info({ ...finished, refusedHosts: end.refusedHosts }, 'xb.egress.refused');
    }

    if (end.result.ok) {
      const user = end.result.value;
      if (!end.storageState) {
        return fail('TRANSIENT', 'TRANSIENT', 'The browser kept no session of the login.');
      }
      const sealed = await deps.sealer.seal(
        JSON.stringify(end.storageState),
        xbSessionAad(command.workspaceId, user.id),
      );
      await deps.report({
        kind: 'login.succeeded',
        ...scope,
        user,
        session: Buffer.from(sealed).toString('base64'),
      });
      deps.logger.info({ ...finished, outcome: 'ok' }, 'xb.login.finished');
      return { ok: true, data: {} };
    }

    const { error } = end.result;
    if (expiry.reached) {
      return fail('TIMEOUT', 'TRANSIENT', 'The login ran out of time.');
    }
    if (!isFlowError(error)) {
      deps.logger.warn(
        { ...finished, errorName: error instanceof Error ? error.name : 'unknown' },
        'xb.login.error',
      );
      return fail('TRANSIENT', 'TRANSIENT', 'The browser task failed.');
    }
    if (error.code === 'SELECTOR_DRIFT' && error.selector !== null) {
      await deps.report({
        kind: 'drift',
        flow: 'login',
        selector: error.selector,
        selectorsVersion: deps.selectorsVersion,
      });
    }
    const failure = failureOf(error.code);
    const code = failure === 'CHALLENGE_REQUIRED' || failure === 'SELECTOR_DRIFT' ? failure : 'TRANSIENT';
    return fail(failure, code, error.message.slice(0, 500));
  }
}
