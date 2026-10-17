import type { Logger } from '@smp/observability';
import {
  isFlowError,
  xbSessionAad,
  type FlowError,
  type XbCommand,
  type XbFailure,
  type XbFlow,
  type XbOperation,
  type XbOutcome,
  type XbReport,
  type XbTarget,
} from '@smp/x-browser';
import type { Page } from 'playwright';
import { z } from 'zod';

import type { AccountGuard } from './account-guard';
import type { BrowserHost, StorageState } from './browser-host';
import { mediaFileName, type MediaFetcher, type MediaFile } from './media';

// Runs one command of the queue xb-commands on an X account (guide step 6.2). Before the browser
// starts: the kill switch, the deadline of the caller and the guard of the account. The session
// opens only here and goes back sealed after the task, like every drift, as a report on
// xb-results. The outcome is the return value of the job, which the caller awaits. Logs carry
// ids, codes and hosts, never texts, sessions or the messages of the browser.

export type AccountOperation = Exclude<XbOperation, 'login.start'>;
type Data<O extends AccountOperation> = Extract<XbOutcome<O>, { ok: true }>['data'];

/** What the browser does for each command: the flows of the selector map (guide step 6.3). */
export type XbFlows = { readonly selectorsVersion: string } & {
  readonly [O in AccountOperation]: (
    page: Page,
    command: XbCommand<O>,
    media: readonly MediaFile[],
  ) => Promise<Data<O>>;
};

export interface SessionSealer {
  seal(plaintext: string, aad: string): Promise<Uint8Array>;
  open(sealed: Uint8Array, aad: string): Promise<string>;
}

export interface RunnerDependencies {
  host: Pick<BrowserHost, 'run'>;
  guard: Pick<AccountGuard, 'acquire' | 'spaced'>;
  sealer: SessionSealer;
  flows: XbFlows;
  media: MediaFetcher;
  report(report: XbReport): Promise<void>;
  killed(): Promise<boolean>;
  now(): Date;
  logger: Pick<Logger, 'info' | 'warn'>;
}

/** Asks the queue to run the command again after the wait, without using an attempt. */
export class Postponed extends Error {
  constructor(
    readonly waitMs: number,
    readonly reason: 'locked' | 'spacing',
  ) {
    super(`Postponed for ${String(waitMs)} ms: ${reason}.`);
    this.name = 'Postponed';
  }
}

const cookieSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']),
});
const storageStateSchema = z.looseObject({
  cookies: z.array(cookieSchema),
  origins: z.array(
    z.looseObject({
      origin: z.string(),
      localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
});

const failure = (
  code: XbFailure['code'],
  message: string,
  retryAfterMs?: number | null,
): { ok: false; error: XbFailure } => ({
  ok: false,
  error: {
    code,
    message: message.slice(0, 500),
    ...(retryAfterMs ? { retryAfterMs } : {}),
  },
});

/** The codes of the login that a command on a stored session reads differently. */
const commandCodeOf = (code: FlowError['code']): XbFailure['code'] => {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return 'AUTH_EXPIRED';
    case 'INVALID_CODE':
    case 'TIMEOUT':
      return 'TRANSIENT';
    default:
      return code;
  }
};

/** Codes after which the stored session is no longer worth keeping. */
const SESSION_LOST = new Set<FlowError['code']>([
  'AUTH_EXPIRED',
  'CHALLENGE_REQUIRED',
  'INVALID_CREDENTIALS',
]);

export class CommandRunner {
  constructor(private readonly deps: RunnerDependencies) {}

  async run<O extends AccountOperation>(operation: O, command: XbCommand<O>): Promise<XbOutcome<O>> {
    const { deps } = this;
    if (await deps.killed()) {
      return failure('UNAVAILABLE', 'The X browser is switched off.') as XbOutcome<O>;
    }
    if (Date.parse(command.deadline) <= deps.now().getTime()) {
      return failure('EXPIRED', 'The command started after its deadline.') as XbOutcome<O>;
    }
    const { target } = command;
    const guard = await deps.guard.acquire(target.accountId, command.commandId, operation === 'publish');
    if (guard.kind === 'busy') {
      throw new Postponed(guard.waitMs, guard.reason);
    }
    try {
      return await this.inBrowser(operation, command);
    } finally {
      await guard.release();
    }
  }

  private async inBrowser<O extends AccountOperation>(
    operation: O,
    command: XbCommand<O>,
  ): Promise<XbOutcome<O>> {
    const { deps } = this;
    const { target } = command;
    const log = { commandId: command.commandId, operation, accountId: target.accountId };
    const opened = await this.openSession(target);
    if (!opened) {
      deps.logger.warn(log, 'xb.session.unreadable');
      return failure('AUTH_EXPIRED', 'The session of the account does not open.') as XbOutcome<O>;
    }
    let media: MediaFile[] = [];
    if (operation === 'publish') {
      try {
        media = await this.loadMedia(command as XbCommand<'publish'>);
      } catch (error) {
        deps.logger.warn(
          { ...log, reason: (error as { reason?: string }).reason ?? 'unknown' },
          'xb.media.failed',
        );
        return failure('TRANSIENT', 'The media of the post could not be loaded.') as XbOutcome<O>;
      }
    }

    const startedAt = deps.now().getTime();
    const flow = deps.flows[operation] as (
      page: Page,
      command: XbCommand<O>,
      media: readonly MediaFile[],
    ) => Promise<Data<O>>;
    const end = await deps.host.run({ storageState: opened.state, locale: target.locale }, (page) =>
      flow(page, command, media),
    );
    if (operation === 'publish') {
      // The post may have gone out, whatever the outcome says.
      await deps.guard.spaced(target.accountId);
    }
    const finished = { ...log, durationMs: deps.now().getTime() - startedAt };
    if (end.refusedHosts.length > 0) {
      deps.logger.info({ ...finished, refusedHosts: end.refusedHosts }, 'xb.egress.refused');
    }

    if (end.result.ok) {
      await this.storeSession(target, opened.plaintext, end.storageState);
      if (operation === 'canary') {
        const { missing } = end.result.value as Data<'canary'>;
        await this.reportCanary(missing.length === 0, missing);
      }
      deps.logger.info({ ...finished, outcome: 'ok' }, 'xb.command.finished');
      return { ok: true, data: end.result.value } as XbOutcome<O>;
    }

    const { error } = end.result;
    if (!isFlowError(error)) {
      // A failure the flow did not name: a post or a deletion may have happened.
      const code = operation === 'publish' || operation === 'delete' ? 'OUTCOME_UNKNOWN' : 'TRANSIENT';
      deps.logger.warn(
        { ...finished, outcome: code, errorName: error instanceof Error ? error.name : 'unknown' },
        'xb.command.failed',
      );
      if (operation === 'canary') {
        await this.reportCanary(false, []);
      }
      return failure(code, 'The browser task failed.') as XbOutcome<O>;
    }
    if (error.code === 'SELECTOR_DRIFT' && error.selector !== null) {
      await deps.report({
        kind: 'drift',
        flow: operation satisfies XbFlow,
        selector: error.selector,
        selectorsVersion: deps.flows.selectorsVersion,
      });
    }
    if (!SESSION_LOST.has(error.code)) {
      await this.storeSession(target, opened.plaintext, end.storageState);
    }
    if (operation === 'canary') {
      await this.reportCanary(false, error.selector === null ? [] : [error.selector]);
    }
    const code = commandCodeOf(error.code);
    deps.logger.warn({ ...finished, outcome: code, selector: error.selector }, 'xb.command.failed');
    return failure(code, error.message, error.retryAfterMs) as XbOutcome<O>;
  }

  private async openSession(target: XbTarget): Promise<{ state: StorageState; plaintext: string } | null> {
    try {
      const plaintext = await this.deps.sealer.open(
        Buffer.from(target.session, 'base64'),
        xbSessionAad(target.workspaceId, target.externalUserId),
      );
      const state = storageStateSchema.parse(JSON.parse(plaintext)) as StorageState;
      return { state, plaintext };
    } catch {
      return null;
    }
  }

  private loadMedia(command: XbCommand<'publish'>): Promise<MediaFile[]> {
    return Promise.all(
      command.media.map(async (item, index) => ({
        name: mediaFileName(index, item.mimeType),
        mimeType: item.mimeType,
        buffer: await this.deps.media(item.url),
        altText: item.altText,
      })),
    );
  }

  /** Seals the storage state again and reports it, unless it did not change. */
  private async storeSession(target: XbTarget, before: string, state: StorageState | null): Promise<void> {
    if (!state) {
      return;
    }
    const plaintext = JSON.stringify(state);
    if (plaintext === before) {
      return;
    }
    const sealed = await this.deps.sealer.seal(
      plaintext,
      xbSessionAad(target.workspaceId, target.externalUserId),
    );
    await this.deps.report({
      kind: 'session.updated',
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      externalUserId: target.externalUserId,
      session: Buffer.from(sealed).toString('base64'),
    });
  }

  private reportCanary(ok: boolean, missing: readonly string[]): Promise<void> {
    return this.deps.report({
      kind: 'canary',
      ok,
      missing: missing.slice(0, 50),
      selectorsVersion: this.deps.flows.selectorsVersion,
    });
  }
}
