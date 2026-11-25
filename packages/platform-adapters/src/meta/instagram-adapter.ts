import { setTimeout as sleepFor } from 'node:timers/promises';

import {
  isPlatformError,
  PlatformError,
  type AccountMetricsResult,
  type AdapterContext,
  type AdapterLogger,
  type Clock,
  type ExternalPostRef,
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
import { z } from 'zod';

import { PlatformHttpClient } from '../http/platform-http-client';
import type { PlatformRateLimiter } from '../rate-limit/platform-rate-limiter';
import { graphInsightsSchema, type GraphInsights } from './facebook-metrics-map';
import { GraphApi } from './graph-api';
import { loginConfigIdSchema, resolveMetaAppConfig, type MetaAppConfig } from './graph-config';
import { endsBatch, isMissingObject } from './graph-errors';
import { InstagramConnector, type InstagramConnectorOptions } from './instagram-connector';
import {
  INSTAGRAM_MAP_VERSION,
  INSTAGRAM_MEDIA_METRICS,
  normalizeInstagramAccountMetrics,
  normalizeInstagramPostMetrics,
} from './instagram-metrics-map';
import { MetaLogin } from './meta-login';
import { graphId, mediaItemsOf, parseGraphTime, sameText, unixSeconds } from './meta-shared';
import { publicMediaUrl } from './public-media-url';

// The adapter of Instagram professional accounts (guide step 4.13, architecture 4.2).
//
// Setup: Instagram API with Facebook Login (graph.facebook.com, Page token of the linked Page),
// not the Instagram API with Instagram Login (graph.instagram.com). Reasons, all checked
// 2026-11-25:
// - Facebook Login allows http://localhost redirects in development mode
//   (facebook-connector.ts); for Business Login for Instagram the docs say nothing about HTTP or
//   localhost, only that the URI must match exactly.
//   https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// - One Meta app, one app id and secret, one login for Facebook and Instagram; Instagram Login
//   needs its own Instagram app id and secret.
// - "DELETE /<IG_MEDIA_ID>" works with Facebook Login only, and saved, shares and caption on
//   media are "Available for Instagram API with Facebook Login only".
//   https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media
// - The cost: the Instagram account must be linked to a Facebook Page the user manages, which a
//   person posting to their own Page has anyway. The overview recommends "Instagram API with
//   Unified Login" for new integrations; it needs a business portfolio and system user tokens,
//   too much for one person.
//   https://developers.facebook.com/documentation/instagram-platform/overview
//
// Publishing, checked 2026-11-25:
// https://developers.facebook.com/documentation/instagram-platform/content-publishing,
// https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media,
// https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media_publish,
// https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container,
// https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
// 1. GET /{ig-user}/content_publishing_limit?fields=quota_usage,config: quota_total "currently 50"
//    per 86,400 s. The guide also says 100 posts per 24 hours; the answer of the API wins.
// 2. POST /{ig-user}/media with image_url (fetched by Meta from a public server), caption and
//    alt_text; a carousel gets its children with is_carousel_item=true first, then a parent with
//    media_type=CAROUSEL and children. JPEG only; containers expire after 24 hours; at most 400
//    containers per 24 hours.
// 3. GET /{container}?fields=status_code,status until FINISHED (EXPIRED, ERROR, FINISHED,
//    IN_PROGRESS, PUBLISHED). Meta suggests "once per minute, for no more than 5 minutes"; the
//    guide adds early looks after 5, 15 and 30 seconds.
// 4. POST /{ig-user}/media_publish with creation_id; config_issue reports a partial success.
// The container ids go to PublishResult.meta and to the log, so a failed attempt can be traced.
// The first comment is not sent yet (needs instagram_manage_comments).

export interface InstagramAdapterConfig {
  app: MetaAppConfig;
  clock: Clock;
  /**
   * The public base URL that serves the media storage, for example an HTTPS tunnel to it. The path
   * and query of each signed media URL are moved onto it. Required when the storage is local.
   */
  publicMediaBaseUrl?: string;
  /** A Facebook Login for Business configuration (optional; otherwise the scope parameter). */
  loginConfigId?: string;
  /** Overrides the requested permissions (INSTAGRAM_SCOPES). */
  scopes?: InstagramConnectorOptions['scopes'];
  limiter?: PlatformRateLimiter;
  logger?: AdapterLogger;
  fetch?: typeof fetch;
  /** The wait between status looks; tests replace it. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The waits before the second, third and fourth status look; then every minute. */
export const CONTAINER_POLL_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const POLL_EVERY_MS = 60_000;
/** The longest a publish waits for its containers. */
export const CONTAINER_MAX_WAIT_MS = 5 * 60_000;

const DEFAULT_QUOTA_TOTAL = 50;
const QUOTA_WAIT_MS = 60 * 60_000;
const RECONCILE_POSTS = 25;

const createdSchema = z.object({ id: z.string().min(1) });
const publishedSchema = z.object({ id: z.string().min(1), config_issue: z.string().optional() });
const successSchema = z.object({ success: z.boolean() });
const statusSchema = z.object({
  id: z.string().optional(),
  status_code: z.string(),
  status: z.string().optional(),
});
const limitSchema = z.object({
  data: z.array(
    z.object({
      quota_usage: z.number().int().nonnegative().optional(),
      config: z.object({ quota_total: z.number().int().positive().optional() }).optional(),
    }),
  ),
});
const mediaInfoSchema = z.object({
  id: z.string(),
  permalink: z.string().optional(),
  timestamp: z.string().optional(),
});
const mediaListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      caption: z.string().optional(),
      timestamp: z.string().optional(),
      permalink: z.string().optional(),
    }),
  ),
});
const userSchema = z.object({ id: z.string(), followers_count: z.number().int().nonnegative().optional() });

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => sleepFor(ms, undefined, { signal });

export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform = 'INSTAGRAM' as const;
  readonly method = 'API' as const;
  readonly connector: InstagramConnector;

  private readonly graph: GraphApi;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly publicMediaBaseUrl: string | undefined;

  constructor(private readonly config: InstagramAdapterConfig) {
    const app = resolveMetaAppConfig(config.app);
    const http = new PlatformHttpClient({
      platform: 'INSTAGRAM',
      limiter: config.limiter,
      logger: config.logger,
      fetch: config.fetch,
    });
    this.graph = new GraphApi(http, app);
    this.connector = new InstagramConnector(new MetaLogin(this.graph), {
      loginConfigId: loginConfigIdSchema.parse(config.loginConfigId),
      scopes: config.scopes,
    });
    this.sleep = config.sleep ?? defaultSleep;
    this.publicMediaBaseUrl = z.url().optional().parse(config.publicMediaBaseUrl);
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('INSTAGRAM');
  }

  /** The account publishes with a Page token (no expiry by time); a refused one needs a new login. */
  refreshCredentials(): Promise<RefreshOutcome> {
    return Promise.resolve({ status: 'not_supported' });
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: 'INSTAGRAM',
      text: request.text,
      firstComment: request.firstComment,
      media: mediaItemsOf(request),
    });
  }

  async publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult> {
    if (ctx.dryRun) {
      throw new Error('A dry run must not reach publish.');
    }
    if (request.media.length === 0) {
      throw new PlatformError('VALIDATION_REJECTED', 'An Instagram post needs at least one image', {
        retryable: false,
      });
    }
    if (request.media.some((item) => item.mimeType.toLowerCase() !== 'image/jpeg')) {
      throw new PlatformError('VALIDATION_REJECTED', 'The Instagram adapter publishes JPEG images only', {
        retryable: false,
      });
    }
    // Before any call: a URL Meta cannot reach fails the post right away.
    const imageUrls = request.media.map((item) => publicMediaUrl(item.url, this.publicMediaBaseUrl));
    const token = await ctx.credentials.accessToken();
    const igUserId = graphId(ctx.account.externalId);
    const deadline = this.config.clock.now().getTime() + CONTAINER_MAX_WAIT_MS;

    await this.checkPublishingLimit(igUserId, token, ctx);

    const childIds: string[] = [];
    let creationId: string;
    const [single] = imageUrls;
    if (imageUrls.length === 1 && single !== undefined) {
      creationId = await this.createContainer(
        igUserId,
        { image_url: single, caption: request.text, ...altText(request.media[0]?.altText) },
        token,
        ctx,
      );
    } else {
      for (const [index, imageUrl] of imageUrls.entries()) {
        const childId = await this.createContainer(
          igUserId,
          { image_url: imageUrl, is_carousel_item: 'true', ...altText(request.media[index]?.altText) },
          token,
          ctx,
        );
        childIds.push(childId);
      }
      ctx.logger.info({ platform: 'INSTAGRAM', childIds }, 'instagram.containers.created');
      for (const childId of childIds) {
        await this.waitUntilFinished(childId, token, ctx, deadline);
      }
      creationId = await this.createContainer(
        igUserId,
        { media_type: 'CAROUSEL', children: childIds.join(','), caption: request.text },
        token,
        ctx,
      );
    }
    ctx.logger.info({ platform: 'INSTAGRAM', creationId, childIds }, 'instagram.container.created');
    await this.waitUntilFinished(creationId, token, ctx, deadline);

    const published = await this.graph.call({
      operation: 'instagram.media.publish',
      method: 'POST',
      path: `/${igUserId}/media_publish`,
      token,
      form: { creation_id: creationId },
      schema: publishedSchema,
      idempotent: false,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    if (published.config_issue !== undefined) {
      // The media is out, but without its caption or tags: a partial success, not an error.
      ctx.logger.warn(
        { platform: 'INSTAGRAM', mediaId: published.id, configIssue: published.config_issue },
        'instagram.publish.partial',
      );
    }
    const info = await this.mediaInfo(published.id, token, ctx);
    return {
      externalPostId: published.id,
      externalUrl: info?.permalink ?? null,
      publishedAt:
        (info?.timestamp === undefined ? null : parseGraphTime(info.timestamp)) ?? this.config.clock.now(),
      meta: {
        creationId,
        childContainerIds: childIds,
        ...(published.config_issue === undefined ? {} : { configIssue: published.config_issue }),
      },
    };
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const token = await ctx.credentials.accessToken();
    // GET /{ig-user}/media supports time-based pagination with since and until.
    const media = await this.graph.call({
      operation: 'instagram.media.list',
      method: 'GET',
      path: `/${graphId(ctx.account.externalId)}/media`,
      token,
      query: {
        fields: 'id,caption,timestamp,permalink',
        since: unixSeconds(query.since),
        limit: String(RECONCILE_POSTS),
      },
      schema: mediaListSchema,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    for (const item of media.data) {
      const createdAt = item.timestamp === undefined ? null : parseGraphTime(item.timestamp);
      if (createdAt !== null && createdAt >= query.since && sameText(item.caption, query.text)) {
        return { externalPostId: item.id, externalUrl: item.permalink ?? null, publishedAt: createdAt };
      }
    }
    return null;
  }

  /** DELETE /{ig-media-id}; a carousel goes as a whole (instagram_manage_contents). */
  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    const token = await ctx.credentials.accessToken();
    const answer = await this.graph.call({
      operation: 'instagram.media.delete',
      method: 'DELETE',
      path: `/${graphId(ref.externalPostId)}`,
      token,
      schema: successSchema,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    if (!answer.success) {
      throw new PlatformError('TRANSIENT', 'instagram.media.delete was not confirmed');
    }
  }

  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const token = await ctx.credentials.accessToken();
    const results: PostMetricsResult[] = [];
    for (const ref of refs) {
      try {
        const insights = await this.graph.call({
          operation: 'instagram.media.insights',
          method: 'GET',
          path: `/${graphId(ref.externalPostId)}/insights`,
          token,
          query: { metric: INSTAGRAM_MEDIA_METRICS.join(',') },
          schema: graphInsightsSchema,
          accountId: ctx.account.id,
          signal: ctx.signal,
        });
        const raw = { instagram: { insights } };
        results.push({
          kind: 'metrics',
          externalPostId: ref.externalPostId,
          metrics: normalizeInstagramPostMetrics(raw),
          raw,
          mappingVersion: INSTAGRAM_MAP_VERSION,
        });
      } catch (error) {
        if (isMissingObject(error)) {
          results.push({ kind: 'deleted', externalPostId: ref.externalPostId });
        } else if (endsBatch(error)) {
          throw error;
        } else {
          ctx.logger.warn(
            { platform: 'INSTAGRAM', operation: 'instagram.media.insights' },
            'instagram.metrics.skipped',
          );
        }
      }
    }
    return results;
  }

  async fetchAccountMetrics(
    range: { from: Date; to: Date },
    ctx: AdapterContext,
  ): Promise<AccountMetricsResult> {
    const token = await ctx.credentials.accessToken();
    const igUserId = graphId(ctx.account.externalId);
    const user = await this.graph.call({
      operation: 'instagram.user.read',
      method: 'GET',
      path: `/${igUserId}`,
      token,
      query: { fields: 'id,followers_count' },
      schema: userSchema,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    let insights: GraphInsights | null = null;
    try {
      insights = await this.graph.call({
        operation: 'instagram.user.insights',
        method: 'GET',
        path: `/${igUserId}/insights`,
        token,
        query: {
          metric: 'reach',
          period: 'day',
          metric_type: 'total_value',
          since: unixSeconds(range.from),
          until: unixSeconds(range.to),
        },
        schema: graphInsightsSchema,
        accountId: ctx.account.id,
        signal: ctx.signal,
      });
    } catch (error) {
      if (isPlatformError(error) && (error.code === 'AUTH_EXPIRED' || error.code === 'RATE_LIMITED')) {
        throw error;
      }
    }
    const raw = { instagram: { user, insights } };
    return { ...normalizeInstagramAccountMetrics(raw), raw, mappingVersion: INSTAGRAM_MAP_VERSION };
  }

  private async checkPublishingLimit(igUserId: string, token: string, ctx: AdapterContext): Promise<void> {
    const limit = await this.graph.call({
      operation: 'instagram.publishing_limit.read',
      method: 'GET',
      path: `/${igUserId}/content_publishing_limit`,
      token,
      query: { fields: 'quota_usage,config' },
      schema: limitSchema,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    const [entry] = limit.data;
    const usage = entry?.quota_usage ?? 0;
    const total = entry?.config?.quota_total ?? DEFAULT_QUOTA_TOTAL;
    if (usage >= total) {
      throw new PlatformError(
        'RATE_LIMITED',
        `The Instagram account published ${String(usage)} of ${String(total)} posts in the last 24 hours`,
        { retryAfterMs: QUOTA_WAIT_MS },
      );
    }
  }

  /** Creating a container publishes nothing, so a repeated call only leaves an unused container. */
  private async createContainer(
    igUserId: string,
    form: Record<string, string>,
    token: string,
    ctx: AdapterContext,
  ): Promise<string> {
    const created = await this.graph.call({
      operation: 'instagram.container.create',
      method: 'POST',
      path: `/${igUserId}/media`,
      token,
      form,
      schema: createdSchema,
      idempotent: true,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    return created.id;
  }

  private async waitUntilFinished(
    containerId: string,
    token: string,
    ctx: AdapterContext,
    deadline: number,
  ): Promise<void> {
    for (let look = 0; ; look += 1) {
      const status = await this.graph.call({
        operation: 'instagram.container.status',
        method: 'GET',
        path: `/${graphId(containerId)}`,
        token,
        query: { fields: 'status_code,status' },
        schema: statusSchema,
        accountId: ctx.account.id,
        signal: ctx.signal,
      });
      switch (status.status_code) {
        case 'FINISHED':
        case 'PUBLISHED':
          return;
        case 'ERROR':
          throw new PlatformError(
            'VALIDATION_REJECTED',
            `Instagram could not process the media container (status ${statusDetail(status.status)})`,
            { retryable: false, platformCode: statusDetail(status.status) },
          );
        case 'EXPIRED':
          throw new PlatformError('TRANSIENT', 'The Instagram media container expired before publishing');
        default:
          break;
      }
      const wait = CONTAINER_POLL_DELAYS_MS[look] ?? POLL_EVERY_MS;
      if (this.config.clock.now().getTime() + wait > deadline) {
        throw new PlatformError(
          'MEDIA_PROCESSING',
          'Instagram did not finish the media container within 5 minutes',
        );
      }
      await ctx.keepAlive();
      await this.sleep(wait, ctx.signal);
    }
  }

  /** Permalink and time of the published media; the post is out even when this read fails. */
  private async mediaInfo(
    mediaId: string,
    token: string,
    ctx: AdapterContext,
  ): Promise<z.infer<typeof mediaInfoSchema> | null> {
    try {
      return await this.graph.call({
        operation: 'instagram.media.read',
        method: 'GET',
        path: `/${graphId(mediaId)}`,
        token,
        query: { fields: 'id,permalink,timestamp' },
        schema: mediaInfoSchema,
        accountId: ctx.account.id,
        signal: ctx.signal,
      });
    } catch {
      ctx.logger.warn({ platform: 'INSTAGRAM', mediaId }, 'instagram.media.read_failed');
      return null;
    }
  }
}

const altText = (text: string | null | undefined): Record<string, string> =>
  text === null || text === undefined || text.trim() === '' ? {} : { alt_text: text.slice(0, 1000) };

/** The subcode of a failed container ("If status_code is ERROR, this value will be an error subcode"). */
function statusDetail(status: string | undefined): string {
  const digits = status === undefined ? null : /\d{3,10}/.exec(status);
  return digits?.[0] ?? 'unknown';
}

export function createInstagramAdapter(config: InstagramAdapterConfig): InstagramAdapter {
  return new InstagramAdapter(config);
}
