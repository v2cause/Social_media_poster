import { randomUUID } from 'node:crypto';

import {
  PlatformError,
  type AccountMetricsResult,
  type AdapterContext,
  type Clock,
  type ExternalPostRef,
  type OAuthConnector,
  type PlatformErrorCode,
  type PostMetricsResult,
  type PublishRequest,
  type PublishResult,
  type RefreshOutcome,
  type SocialPlatformAdapter,
} from '@smp/core';
import {
  capabilitiesOf,
  validatePost,
  type PlatformCapabilities,
  type ValidationIssue,
} from '@smp/platform-rules';
import {
  parseXbCommand,
  xHandleSchema,
  xbLocaleSchema,
  type XbCommand,
  type XbFailure,
  type XbOperation,
  type XbOutcome,
  type XbTarget,
} from '@smp/x-browser';

import { CommandNotAnsweredError, type XbCommandBus } from './command-bus';
import { normalizeXBrowserPostMetrics, X_BROWSER_MAP_VERSION } from './metrics-map';

// The adapter of X through the browser worker (architecture 4.1 and 4.3, guide step 6.3): every
// call becomes a command on xb-commands, and the outcome comes back as the return value of its
// job. The command carries the sealed session, the text and the signed media URLs; the worker
// opens nothing. A command without an outcome counts as maybe sent for a post or a deletion.

/** How long a command may wait in the queue before the browser worker no longer starts it. */
export const XB_START_WINDOW_MS = 2 * 60_000;
/** How long a running command may take, on top of its start window. */
const TASK_MS: Readonly<Record<Exclude<XbOperation, 'login.start'>, number>> = {
  publish: 4 * 60_000,
  reconcile: 2 * 60_000,
  metrics: 3 * 60_000,
  'account-metrics': 2 * 60_000,
  delete: 2 * 60_000,
  'verify-session': 2 * 60_000,
  canary: 2 * 60_000,
};
/** The browser worker reads the counters of ten posts per command. */
const METRICS_PER_COMMAND = 10;

/** The browser method has no OAuth: its accounts come from the interactive login (guide step 6.4). */
const NO_OAUTH: OAuthConnector = {
  scopes: [],
  usesPkce: false,
  authorizationUrl: () => {
    throw new Error('X without the API connects through the login of the browser worker.');
  },
  exchangeCode: () => Promise.reject(new Error('X without the API has no OAuth.')),
  listConnectableAccounts: () => Promise.resolve([]),
  revoke: () => Promise.resolve(),
};

/** The failures of the browser worker in the error taxonomy of the adapters. */
const CODES: Readonly<Record<XbFailure['code'], PlatformErrorCode>> = {
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  CHALLENGE_REQUIRED: 'CHALLENGE_REQUIRED',
  SELECTOR_DRIFT: 'SELECTOR_DRIFT',
  RATE_LIMITED: 'RATE_LIMITED',
  VALIDATION_REJECTED: 'VALIDATION_REJECTED',
  DUPLICATE: 'DUPLICATE',
  TRANSIENT: 'TRANSIENT',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  // Not started: after the deadline, or while the kill switch was on.
  EXPIRED: 'TRANSIENT',
  UNAVAILABLE: 'TRANSIENT',
};

type AccountOperation = Exclude<XbOperation, 'login.start'>;
type Data<O extends AccountOperation> = Extract<XbOutcome<O>, { ok: true }>['data'];

export class XBrowserRemoteAdapter implements SocialPlatformAdapter {
  readonly platform = 'X' as const;
  readonly method = 'BROWSER' as const;
  readonly connector = NO_OAUTH;

  constructor(private readonly deps: { bus: XbCommandBus; clock: Clock; newId?: () => string }) {}

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('X');
  }

  /** A session of the browser is renewed by signing in again only. */
  refreshCredentials(): Promise<RefreshOutcome> {
    return Promise.resolve({ status: 'not_needed' });
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: 'X',
      text: request.text,
      firstComment: request.firstComment,
      media: request.media.map((item) => ({
        kind: 'image',
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
      })),
    });
  }

  async publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult> {
    if (ctx.dryRun) {
      throw new Error('A dry run must not reach publish.');
    }
    const posted = await this.call('publish', ctx, {
      text: request.text,
      media: request.media.map((item) => ({ url: item.url, mimeType: item.mimeType, altText: item.altText })),
    });
    return {
      externalPostId: posted.externalPostId,
      externalUrl: posted.externalUrl,
      publishedAt: new Date(posted.publishedAt),
    };
  }

  /** X has no content hash; the browser worker looks for the text in the posts of the profile. */
  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const { found } = await this.call('reconcile', ctx, {
      text: query.text,
      since: query.since.toISOString(),
    });
    return found
      ? {
          externalPostId: found.externalPostId,
          externalUrl: found.externalUrl,
          publishedAt: new Date(found.publishedAt),
        }
      : null;
  }

  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    await this.call('delete', ctx, { externalPostId: ref.externalPostId });
  }

  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const results: PostMetricsResult[] = [];
    for (let start = 0; start < refs.length; start += METRICS_PER_COMMAND) {
      const ids = refs.slice(start, start + METRICS_PER_COMMAND).map((ref) => ref.externalPostId);
      const { items } = await this.call('metrics', ctx, { externalPostIds: ids });
      for (const item of items) {
        results.push(
          item.kind === 'deleted'
            ? item
            : {
                kind: 'metrics',
                externalPostId: item.externalPostId,
                metrics: normalizeXBrowserPostMetrics(item.counts),
                raw: item.raw,
                mappingVersion: X_BROWSER_MAP_VERSION,
              },
        );
      }
    }
    return results;
  }

  async fetchAccountMetrics(_range: unknown, ctx: AdapterContext): Promise<AccountMetricsResult> {
    const { followers, raw } = await this.call('account-metrics', ctx, {});
    return { followers, reach: null, profileViews: null, raw, mappingVersion: X_BROWSER_MAP_VERSION };
  }

  /** Sends one command for the account of the context and returns the data of its outcome. */
  private async call<O extends AccountOperation>(
    operation: O,
    ctx: AdapterContext,
    /** The fields of the command beyond id, deadline and target; zod checks them before they go out. */
    input: Readonly<Record<string, unknown>>,
  ): Promise<Data<O>> {
    const now = this.deps.clock.now().getTime();
    let command: XbCommand<O>;
    try {
      command = parseXbCommand(operation, {
        ...input,
        commandId: this.deps.newId?.() ?? randomUUID(),
        deadline: new Date(now + XB_START_WINDOW_MS).toISOString(),
        target: targetOf(ctx),
      });
    } catch (error) {
      if (error instanceof PlatformError) {
        throw error;
      }
      // Nothing went out: the post does not fit what the browser worker takes.
      throw new PlatformError(
        'VALIDATION_REJECTED',
        `The ${operation} command does not fit the browser worker.`,
      );
    }
    let outcome: XbOutcome<O>;
    try {
      outcome = await this.deps.bus.send(operation, command, {
        waitMs: XB_START_WINDOW_MS + TASK_MS[operation],
        signal: ctx.signal,
        heartbeat: () => ctx.keepAlive(),
      });
    } catch (error) {
      if (!(error instanceof CommandNotAnsweredError)) {
        throw error;
      }
      const maybeSent = operation === 'publish' || operation === 'delete';
      throw new PlatformError(
        maybeSent ? 'OUTCOME_UNKNOWN' : 'TRANSIENT',
        `The browser worker gave no outcome (${error.reason}).`,
      );
    }
    if (outcome.ok) {
      return outcome.data;
    }
    const { code, message, retryAfterMs } = outcome.error;
    throw new PlatformError(CODES[code], message, retryAfterMs === undefined ? {} : { retryAfterMs });
  }
}

/** The account of a call as the browser worker needs it; without a session X needs a new login. */
function targetOf(ctx: AdapterContext): XbTarget {
  const browser = ctx.browser;
  if (!browser?.sessionSealed) {
    throw new PlatformError('AUTH_EXPIRED', 'The connection has no browser session.');
  }
  const { account } = ctx;
  const handle = xHandleSchema.safeParse(account.handle);
  const locale = xbLocaleSchema.safeParse(account.settings['locale']);
  return {
    organizationId: browser.organizationId,
    workspaceId: account.workspaceId,
    connectionId: account.connectionId,
    accountId: account.id,
    externalUserId: account.externalId,
    handle: handle.success ? handle.data : null,
    locale: locale.success ? locale.data : 'de',
    session: Buffer.from(browser.sessionSealed).toString('base64'),
  };
}
