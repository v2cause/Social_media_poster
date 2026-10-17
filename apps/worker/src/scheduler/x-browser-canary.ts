import { randomUUID } from 'node:crypto';

import type { XBrowserCanaryAccount } from '@smp/db';
import {
  CommandNotAnsweredError,
  XB_START_WINDOW_MS,
  xbWaitMs,
  type XbCommandBus,
} from '@smp/platform-adapters';
import { parseXbCommand, xbLocaleSchema, xHandleSchema } from '@smp/x-browser';

import type { TickResult } from '../processors/scheduler.processor';

// tick.xb-canary (guide step 6.5), daily: the canary of the X browser with the session of the
// internal test account of XB_CANARY_ACCOUNT_ID. It only checks that the selector map still finds
// its entries and posts nothing. What it misses comes back as a report on xb-results, where the
// circuit breaker alerts the platform admins and counts it as a drift; the tick logs the outcome.

export interface CanaryTickDependencies {
  accounts: { canaryAccount(accountId: string): Promise<XBrowserCanaryAccount | null> };
  bus: XbCommandBus;
  accountId: string;
  now: () => Date;
  newId?: () => string;
}

export class XBrowserCanaryTick {
  constructor(private readonly deps: CanaryTickDependencies) {}

  async run(): Promise<TickResult> {
    const { deps } = this;
    const account = await deps.accounts.canaryAccount(deps.accountId);
    if (!account) {
      // Gone, disconnected, without session or not of the browser: the next login fixes it.
      return { canary: 'no_account' };
    }
    const settings = (account.settings ?? {}) as Record<string, unknown>;
    const handle = xHandleSchema.safeParse(account.handle);
    const locale = xbLocaleSchema.safeParse(settings['locale']);
    const command = parseXbCommand('canary', {
      commandId: deps.newId?.() ?? randomUUID(),
      deadline: new Date(deps.now().getTime() + XB_START_WINDOW_MS).toISOString(),
      target: {
        organizationId: account.organizationId,
        workspaceId: account.workspaceId,
        connectionId: account.connectionId,
        accountId: account.accountId,
        externalUserId: account.externalUserId,
        handle: handle.success ? handle.data : null,
        locale: locale.success ? locale.data : 'de',
        session: Buffer.from(account.sessionSealed).toString('base64'),
      },
    });
    try {
      const outcome = await deps.bus.send('canary', command, {
        waitMs: xbWaitMs('canary'),
        signal: new AbortController().signal,
        heartbeat: () => Promise.resolve(),
      });
      return outcome.ok
        ? { canary: 'checked', missing: outcome.data.missing.length }
        : { canary: 'failed', code: outcome.error.code };
    } catch (error) {
      if (error instanceof CommandNotAnsweredError) {
        return { canary: 'unanswered', reason: error.reason };
      }
      throw error;
    }
  }
}
