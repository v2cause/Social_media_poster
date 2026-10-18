import { composePostText, renditionProfileFor } from '@smp/platform-rules';

import { metricsDueAt } from '../../analytics/domain/cadence';
import { browserContextOf } from '../../channels/application/browser-context';
import { ConnectionTokens, ReauthRequiredError } from '../../channels/application/connection-tokens';
import { isPlatformError } from '../../channels/domain/platform-error';
import type { ConnectionMethod, SocialAccountType } from '../../channels/domain/types';
import type {
  AdapterContext,
  PublishMedia,
  PublishRequest,
  SocialPlatformAdapter,
} from '../../channels/ports/platform-adapter';
import { canonicalJson } from '../../content/domain/rules';
import { cropHashOf, READ_URL_SECONDS } from '../../media/domain/rules';
import { PUBLISH_LEASE_MS, reactionTo, RECONCILE_SKEW_MS } from '../domain/publish-job';
import { isConnectionUsable } from '../domain/rules';
import type {
  ApiCostEntry,
  PublishJobStore,
  PublishJobTarget,
  PublishJobVariant,
  PublishMediaItem,
} from '../ports/publish-job';
import {
  statusEvent,
  unitOfJob,
  type ClaimedRun,
  type PublishJobDependencies,
  type PublishJobInput,
  type PublishJobOutcome,
  type RunMedia,
} from './publish-job-types';
import {
  attemptResultOf,
  endOfReaction,
  failedEnd,
  outcomeOf,
  reauthEnd,
  retryOrFailEnd,
  unknownEnd,
  variantResultOf,
  type RunEnd,
} from './run-end';

// One claimed run of the publish job (guide step 4.8, architecture 7, steps 4 to 8, and 7.1):
// it looks for the post of an earlier, unclear attempt first, renews the token, checks the
// content again and sends it, or in a dry run only records what it would send. The end is
// written in one transaction with the costs, the attempt and the event of the new status.
//
// A run that is stopped (the signal is aborted, or the process dies) writes nothing more. Right
// before the request goes out its attempt is marked UNKNOWN, so the next run knows that the post
// may be out and reconciles before it sends again: there is never a second post.

/** Another run took the variant over. */
class LeaseLostError extends Error {
  constructor() {
    super('The run lost its lease.');
    this.name = 'LeaseLostError';
  }
}

/** The content as it goes out, without the signed URLs of its media. */
interface Content {
  text: string;
  contentHash: string;
  items: PublishMediaItem[];
  profile: string;
}

/** The images of a variant with the renditions of its platform, read with the claim. */
export async function readRunMedia(store: PublishJobStore, variant: PublishJobVariant): Promise<RunMedia[]> {
  const profile = renditionProfileFor(variant.platform).key;
  const media: RunMedia[] = [];
  for (const item of await store.media.itemsOf(variant.workspaceId, variant.id)) {
    const cropHash = cropHashOf(item.crop, item.letterbox);
    media.push({
      item,
      rendition: await store.media.rendition(variant.workspaceId, item.assetId, profile, cropHash),
    });
  }
  return media;
}

export class PublishRun {
  /** The version of the variant this run wrote last. */
  private version: number;
  /** Set from the mark before the request until the answer of the platform. */
  private sent = false;
  private tokens: ConnectionTokens | null = null;
  /** How the run reaches the platform, once its adapter is known; it sets the metrics cascade. */
  private method: ConnectionMethod | null = null;
  /** Units of paid calls per operation, booked with the end of the run. */
  private readonly costs = new Map<string, number>();

  constructor(
    private readonly deps: PublishJobDependencies,
    private readonly job: PublishJobInput,
    private readonly claimed: ClaimedRun,
  ) {
    this.version = claimed.version;
  }

  async execute(): Promise<PublishJobOutcome> {
    let end: RunEnd;
    try {
      end = await this.run();
    } catch (error) {
      if (this.job.signal.aborted) {
        throw error;
      }
      end = this.endAfter(error);
    }
    return this.finish(end);
  }

  private async run(): Promise<RunEnd> {
    const { variant, target, media } = this.claimed;
    if (variant.socialAccountId === null) {
      return failedEnd('SOCIAL_ACCOUNT_DISCONNECTED', 'The variant has no account.');
    }
    if (!target || target.disconnectedAt !== null || target.account.platform !== variant.platform) {
      return failedEnd('SOCIAL_ACCOUNT_DISCONNECTED', 'The account is disconnected.');
    }
    if (!isConnectionUsable(target.connection.status)) {
      return failedEnd('REAUTH_REQUIRED', `The connection is ${target.connection.status}.`);
    }
    const adapter = await this.deps.adapters.resolve({
      platform: variant.platform,
      method: target.connection.method,
      organizationId: this.job.organizationId,
      workspaceId: variant.workspaceId,
    });
    if (!adapter) {
      return failedEnd('ADAPTER_UNAVAILABLE', `No adapter for ${variant.platform} is available.`);
    }
    this.method = adapter.method;
    const tokens = new ConnectionTokens(
      this.deps,
      (work) => this.unit((store) => work(store.connections)),
      { account: target.account, accessTokenSealed: target.accessTokenSealed },
      target.connection,
      adapter,
    );
    this.tokens = tokens;
    const context = (): AdapterContext => this.contextFor(target, tokens);
    const content = this.contentOf(
      variant,
      media.map((entry) => entry.item),
    );

    // Step 5 comes first, so the reconcile can read.
    await tokens.refresh(context, false);

    // Step 7: a dry run renews the token like a real run and validates, but neither reads nor
    // sends: real connections can be checked without posts and without the costs of X
    // (architecture 16).
    if (variant.dryRun || (this.deps.dryRunLive && adapter.method !== 'MOCK')) {
      const request = await this.requestFor(variant, content, adapter, target.account.type);
      if (request.kind !== 'ready') {
        return request.end;
      }
      return {
        kind: 'dry_run',
        contentHash: content.contentHash,
        payload: this.payloadOf(request.request, content),
      };
    }

    // Step 4: the post of an earlier, unclear attempt.
    if (this.claimed.unclear.length > 0 || this.job.trigger === 'recheck') {
      const found = await tokens.withToken(context, (ctx) => adapter.reconcile(this.queryFor(content), ctx));
      if (found) {
        return { kind: 'published', result: found, reconciled: true, contentHash: content.contentHash };
      }
      if (this.mustNotSendAgain()) {
        return {
          kind: 'needs_attention',
          code: 'OUTCOME_UNKNOWN',
          errorCode: 'OUTCOME_UNKNOWN',
          message: 'The reconcile found no post of the earlier attempt.',
          unknown: false,
        };
      }
    }

    // Step 6: validate again, with the files the platform gets and their signed URLs.
    const request = await this.requestFor(variant, content, adapter, target.account.type);
    if (request.kind !== 'ready') {
      return request.end;
    }

    // Step 8: from the mark on, a stopped run leaves the attempt UNKNOWN.
    await this.extendLease({ markSent: true });
    this.sent = true;
    try {
      const result = await tokens.withToken(context, (ctx) => adapter.publish(request.request, ctx));
      return { kind: 'published', result, reconciled: false, contentHash: content.contentHash };
    } catch (error) {
      if (
        this.job.signal.aborted ||
        error instanceof LeaseLostError ||
        error instanceof ReauthRequiredError
      ) {
        throw error;
      }
      if (isPlatformError(error) && error.code !== 'OUTCOME_UNKNOWN') {
        // The platform answered: nothing went out.
        return endOfReaction(
          reactionTo(error, { sent: true, lastAttempt: this.job.lastAttempt }),
          error,
          tokens.connectionId,
        );
      }
      return this.reconcileUnknown(adapter, tokens, context, content, error);
    }
  }

  /**
   * After a recheck, or an unclear attempt of this schedule version, a post that cannot be found
   * is no reason to send again: the user decides (architecture 7.1). An unclear attempt of an
   * earlier version was answered by the user already, with "trotzdem posten" or "erneut".
   */
  private mustNotSendAgain(): boolean {
    const { variant, unclear } = this.claimed;
    return (
      this.job.trigger === 'recheck' ||
      unclear.some(
        (attempt) => attempt.outcome === 'UNKNOWN' && attempt.scheduleVersion === variant.scheduleVersion,
      )
    );
  }

  /** The request went out and the answer is missing (architecture 7.1): look for the post. */
  private async reconcileUnknown(
    adapter: SocialPlatformAdapter,
    tokens: ConnectionTokens,
    context: () => AdapterContext,
    content: Content,
    cause: unknown,
  ): Promise<RunEnd> {
    if (!isPlatformError(cause)) {
      this.deps.logger.warn({ variantId: this.claimed.variant.id, err: cause }, 'publish.answer_unreadable');
    }
    const message = isPlatformError(cause) ? cause.message : 'The answer of the platform could not be read.';
    try {
      const found = await tokens.withToken(context, (ctx) => adapter.reconcile(this.queryFor(content), ctx));
      if (found) {
        return { kind: 'published', result: found, reconciled: true, contentHash: content.contentHash };
      }
    } catch (error) {
      if (this.job.signal.aborted || error instanceof LeaseLostError) {
        throw error;
      }
      // Still open: the next run reconciles before anything else.
      return unknownEnd('OUTCOME_UNKNOWN', message, this.job.lastAttempt);
    }
    return {
      kind: 'needs_attention',
      code: 'OUTCOME_UNKNOWN',
      errorCode: 'OUTCOME_UNKNOWN',
      message,
      unknown: true,
    };
  }

  /** The end after an error outside of the publish call. */
  private endAfter(error: unknown): RunEnd {
    const connectionId = this.tokens?.connectionId ?? null;
    if (error instanceof LeaseLostError) {
      return { kind: 'lease_lost', unknown: this.sent };
    }
    if (error instanceof ReauthRequiredError) {
      return reauthEnd(error.reason, connectionId);
    }
    if (isPlatformError(error)) {
      return endOfReaction(
        reactionTo(error, { sent: false, lastAttempt: this.job.lastAttempt }),
        error,
        connectionId,
      );
    }
    this.deps.logger.warn({ variantId: this.claimed.variant.id, err: error }, 'publish.unexpected_error');
    const name = error instanceof Error ? error.name : 'Error';
    return this.sent
      ? unknownEnd('INTERNAL', name, this.job.lastAttempt)
      : retryOrFailEnd('INTERNAL', name, this.job.lastAttempt);
  }

  /** The text, the hash the reconcile looks for, and the media; the same for every run. */
  private contentOf(variant: PublishJobVariant, items: PublishMediaItem[]): Content {
    const text = composePostText(variant.text, variant.hashtags);
    const contentHash = this.deps.hash(
      canonicalJson({
        text,
        firstComment: variant.firstComment,
        linkUrl: variant.linkUrl,
        media: items.map((item) => ({
          assetId: item.assetId,
          cropHash: cropHashOf(item.crop, item.letterbox),
        })),
      }),
    );
    return { text, contentHash, items, profile: renditionProfileFor(variant.platform).key };
  }

  /**
   * The request with the renditions of the platform and signed URLs (an hour), checked by the
   * adapter. A rendition that is not there yet is still being made.
   */
  private async requestFor(
    variant: PublishJobVariant,
    content: Content,
    adapter: SocialPlatformAdapter,
    type: SocialAccountType,
  ): Promise<{ kind: 'ready'; request: PublishRequest } | { kind: 'not_ready'; end: RunEnd }> {
    const media: PublishMedia[] = [];
    for (const { item, rendition } of this.claimed.media) {
      if (!rendition) {
        return {
          kind: 'not_ready',
          end: retryOrFailEnd('MEDIA_PROCESSING', 'A rendition is not ready yet.', this.job.lastAttempt),
        };
      }
      media.push({
        url: await this.deps.storage.signedGetUrl(rendition.storageKey, {
          expiresInSeconds: READ_URL_SECONDS,
        }),
        mimeType: rendition.mimeType,
        width: rendition.width,
        height: rendition.height,
        sizeBytes: rendition.sizeBytes,
        altText: item.altText,
      });
    }
    const request: PublishRequest = {
      variantId: variant.id,
      text: content.text,
      firstComment: variant.firstComment,
      linkUrl: variant.linkUrl,
      media,
      contentHash: content.contentHash,
    };
    const issues = adapter.validatePost(request, type).map((issue): string => issue.code);
    if (request.text.length === 0 && media.length === 0) {
      issues.unshift('CONTENT_REQUIRED');
    }
    if (issues.length > 0) {
      return {
        kind: 'not_ready',
        end: failedEnd('VARIANT_NOT_PUBLISHABLE', [...new Set(issues)].join(', ')),
      };
    }
    return { kind: 'ready', request };
  }

  /** The payload snapshot of a dry run, without the signed URLs. */
  private payloadOf(request: PublishRequest, content: Content): Record<string, unknown> {
    return {
      text: request.text,
      firstComment: request.firstComment,
      linkUrl: request.linkUrl,
      media: request.media.map((item, index) => ({
        assetId: content.items[index]?.assetId ?? null,
        profile: content.profile,
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
        sizeBytes: item.sizeBytes,
        altText: item.altText,
      })),
      contentHash: request.contentHash,
    };
  }

  /**
   * What the reconcile looks for: posts since the first open attempt, this one included once it
   * sent. A recheck without an open attempt looks back to the time the variant was due.
   */
  private queryFor(content: Content): { text: string; since: Date; contentHash: string } {
    const { variant, unclear, startedAt } = this.claimed;
    const starts = [
      ...unclear.map((attempt) => attempt.startedAt.getTime()),
      ...(this.sent ? [startedAt.getTime()] : []),
    ];
    const from =
      starts.length > 0
        ? Math.min(...starts)
        : Math.min(
            startedAt.getTime(),
            variant.queuedAt?.getTime() ?? Number.POSITIVE_INFINITY,
            variant.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY,
          );
    return {
      text: content.text,
      since: new Date(from - RECONCILE_SKEW_MS),
      contentHash: content.contentHash,
    };
  }

  private contextFor(target: PublishJobTarget, tokens: ConnectionTokens): AdapterContext {
    return {
      account: target.account,
      credentials: tokens.credentials(),
      ...browserContextOf(target, this.job.organizationId),
      costs: {
        record: ({ operation, units = 1 }) => {
          this.costs.set(operation, (this.costs.get(operation) ?? 0) + units);
          return Promise.resolve();
        },
      },
      logger: this.deps.logger,
      signal: this.job.signal,
      dryRun: false,
      keepAlive: () => this.extendLease(),
    };
  }

  /**
   * Moves the end of the lease before a long step, by compare-and-swap (architecture 7, step 2).
   * Right before the request goes out it also marks the attempt UNKNOWN, in the same transaction:
   * a run that lost its lease never marks it.
   */
  private async extendLease(options: { markSent?: boolean } = {}): Promise<void> {
    const { variant, attemptId } = this.claimed;
    const until = new Date(this.deps.clock.now().getTime() + (this.deps.leaseMs ?? PUBLISH_LEASE_MS));
    const version = await this.unit(async (store) => {
      const extended = await store.variants.extendLease(variant.workspaceId, variant.id, this.version, {
        owner: this.job.owner,
        until,
      });
      if (extended !== null && options.markSent) {
        await store.attempts.markSent(variant.workspaceId, attemptId);
      }
      return extended;
    });
    if (version === null) {
      throw new LeaseLostError();
    }
    this.version = version;
  }

  /** Writes the end in one transaction: costs, attempt, connection, variant and its event. */
  private async finish(end: RunEnd): Promise<PublishJobOutcome> {
    const { variant, attemptId } = this.claimed;
    const now = this.deps.clock.now();
    const costs = this.costEntries();
    const changed = await this.unit(async (store) => {
      if (costs.length > 0) {
        await store.costs.record(costs);
      }
      await store.attempts.finish(variant.workspaceId, attemptId, attemptResultOf(end, now));
      const reauth = end.kind === 'failed' || end.kind === 'needs_attention' ? end.reauth : undefined;
      if (reauth) {
        const mark = await store.connections.markNeedsReauth(
          variant.workspaceId,
          reauth.connectionId,
          reauth.reason,
        );
        if (mark.changed) {
          await store.outbox.add(variant.workspaceId, {
            type: 'notification.requested',
            payload: {
              type: 'reauth-required',
              connectionId: reauth.connectionId,
              reason: reauth.reason,
              scheduledVariants: mark.scheduledVariants,
            },
          });
        }
      }
      if (end.kind === 'lease_lost') {
        return false;
      }
      const result = variantResultOf(
        end,
        (publishedAt) =>
          metricsDueAt(variant.platform, this.method ?? 'API', publishedAt, 0, this.deps.metricsCadenceScale),
        now,
      );
      if (
        !(await store.variants.finish(variant.workspaceId, variant.id, this.version, this.job.owner, result))
      ) {
        return false;
      }
      await store.outbox.add(variant.workspaceId, statusEvent(variant, result.status));
      // Guide step 4.9: the author hears of a post that failed or needs a decision.
      if (end.kind === 'failed' || end.kind === 'needs_attention') {
        await store.outbox.add(variant.workspaceId, {
          type: 'notification.requested',
          payload: {
            type: end.kind === 'failed' ? 'publish-failed' : 'needs-attention',
            variantId: variant.id,
            failureCode: end.code,
          },
        });
      }
      return true;
    });
    return changed ? outcomeOf(end) : { kind: 'skipped', reason: 'LEASE_LOST' };
  }

  /** The paid calls of the run, once per operation (architecture 4.1, ApiCostRecorder). */
  private costEntries(): ApiCostEntry[] {
    const { variant, attemptId } = this.claimed;
    const accountId = variant.socialAccountId;
    if (accountId === null) {
      return [];
    }
    return [...this.costs].map(([operation, units]) => {
      const price = this.deps.prices.priceMicros(operation);
      if (price === null) {
        this.deps.logger.warn({ operation, variantId: variant.id }, 'publish.price_unknown');
      }
      return {
        organizationId: this.job.organizationId,
        workspaceId: variant.workspaceId,
        socialAccountId: accountId,
        platform: variant.platform,
        operation,
        units,
        costMicros: (price ?? 0) * units,
        sourceType: 'publish_attempt',
        sourceId: attemptId,
      };
    });
  }

  private unit<T>(work: (store: PublishJobStore) => Promise<T>): Promise<T> {
    return unitOfJob(this.deps, this.job, work);
  }
}
