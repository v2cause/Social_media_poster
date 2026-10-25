import {
  isPlatformError,
  PlatformError,
  type AccountMetricsResult,
  type AdapterContext,
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
import { collectUntilLimited, defaultSleep, sameText, type LiveAdapterDeps } from '../live/live-support';
import { bearer, graphErrorOf, idSchema, isNotFound, type InstagramAppConfig } from './graph-api';
import {
  INSTAGRAM_GRAPH_URL,
  InstagramConnector,
  longLivedSchema,
  tokenSetOfLongLived,
} from './instagram-connector';
import {
  INSTAGRAM_MAP_VERSION,
  INSTAGRAM_MEDIA_INSIGHTS,
  insightsAnswerSchema,
  insightValues,
  instagramPostRawSchema,
  normalizeInstagramPostMetrics,
  normalizeMetaAccountMetrics,
} from './metrics-map';

// The Instagram adapter (guide step 4.13, architecture 4.2): Instagram fetches every image itself
// from its signed URL, so the storage has to be reachable over https. A post is a container
// (a carousel: one container per image, then the parent), which Instagram processes until
// FINISHED, and is then published. Before that the publishing limit of the last 24 hours is
// checked. The container ids go into the attempt log.

/** The waits between status polls of a container: 5 s, 15 s, 30 s, then every minute, 5 min in all. */
const CONTAINER_POLL_MS = [5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000];
/** The wait after the publishing limit of the rolling 24 hours is reached. */
const LIMIT_WAIT_MS = 60 * 60 * 1000;
/** The media a reconcile looks through. */
const RECONCILE_MEDIA = 20;

const statusSchema = z.object({ status_code: z.string().optional(), status: z.string().optional() }).loose();
const limitSchema = z.object({
  data: z.array(
    z
      .object({
        quota_usage: z.number().int().nonnegative().optional(),
        config: z.object({ quota_total: z.number().int().positive().optional() }).loose().optional(),
      })
      .loose(),
  ),
});
const permalinkSchema = z.object({ permalink: z.string().optional() }).loose();
const mediaListSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string(),
        caption: z.string().optional(),
        timestamp: z.string().optional(),
        permalink: z.string().optional(),
      })
      .loose(),
  ),
});
const followersSchema = z.object({ followers_count: z.number().int().nonnegative().optional() }).loose();

export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform = 'INSTAGRAM' as const;
  readonly method = 'API' as const;
  readonly connector: InstagramConnector;
  private readonly http: PlatformHttpClient;

  constructor(
    private readonly config: InstagramAppConfig,
    private readonly deps: LiveAdapterDeps,
  ) {
    this.http = new PlatformHttpClient({
      platform: 'INSTAGRAM',
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.limiter ? { limiter: deps.limiter } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.connector = new InstagramConnector(config, this.http, deps.clock);
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('INSTAGRAM');
  }

  /** The long-lived token renews itself for another 60 days (it must be a day old). */
  async refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome> {
    const query = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: await ctx.credentials.accessToken(),
    });
    const { data } = await this.http.request({
      operation: 'instagram.oauth.refresh',
      method: 'GET',
      url: `${INSTAGRAM_GRAPH_URL}/refresh_access_token?${query.toString()}`,
      schema: longLivedSchema,
      signal: ctx.signal,
      mapError: graphErrorOf('instagram.oauth.refresh'),
    });
    // No scopes: the connection keeps the ones it was granted.
    return { status: 'refreshed', tokens: tokenSetOfLongLived(this.deps.clock, data, []) };
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: 'INSTAGRAM',
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
    const user = ctx.account.externalId;
    const token = await ctx.credentials.accessToken();
    await this.checkLimit(user, token, ctx);

    const altOf = (altText: string | null): Record<string, string> =>
      altText === null || altText.length === 0 ? {} : { alt_text: altText };
    let container: string;
    const children: string[] = [];
    const [single, ...more] = request.media;
    if (!single) {
      throw new PlatformError('VALIDATION_REJECTED', 'Instagram posts need an image');
    }
    if (more.length === 0) {
      container = await this.createContainer(
        user,
        { image_url: single.url, caption: request.text, ...altOf(single.altText) },
        token,
        ctx,
      );
      await this.waitUntilFinished(container, token, ctx);
    } else {
      for (const media of request.media) {
        const child = await this.createContainer(
          user,
          { image_url: media.url, is_carousel_item: 'true', ...altOf(media.altText) },
          token,
          ctx,
        );
        await this.waitUntilFinished(child, token, ctx);
        children.push(child);
      }
      container = await this.createContainer(
        user,
        { media_type: 'CAROUSEL', children: children.join(','), caption: request.text },
        token,
        ctx,
      );
      await this.waitUntilFinished(container, token, ctx);
    }

    await ctx.keepAlive();
    const { data } = await this.http.request({
      operation: 'instagram.media.publish',
      method: 'POST',
      url: this.url(`${user}/media_publish`),
      headers: bearer(token),
      body: { form: { creation_id: container } },
      schema: idSchema,
      idempotent: false,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: graphErrorOf('instagram.media.publish'),
    });
    const publishedAt = this.deps.clock.now();
    const permalink = await this.permalinkOf(data.id, token, ctx);
    if (request.firstComment !== null && request.firstComment.length > 0) {
      await this.comment(data.id, request.firstComment, token, ctx);
    }
    return {
      externalPostId: data.id,
      externalUrl: permalink,
      publishedAt,
      meta: { container, ...(children.length > 0 ? { children } : {}) },
    };
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const token = await ctx.credentials.accessToken();
    const { data } = await this.http.request({
      operation: 'instagram.media.list',
      method: 'GET',
      url: this.url(
        `${ctx.account.externalId}/media?fields=id,caption,timestamp,permalink&limit=${String(RECONCILE_MEDIA)}`,
      ),
      headers: bearer(token),
      schema: mediaListSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: graphErrorOf('instagram.media.list'),
    });
    const found = data.data.find((media) => {
      const at = media.timestamp === undefined ? Number.NaN : Date.parse(media.timestamp);
      return at >= query.since.getTime() && sameText(media.caption ?? '', query.text);
    });
    if (!found) {
      return null;
    }
    return {
      externalPostId: found.id,
      externalUrl: found.permalink ?? null,
      publishedAt: new Date(Date.parse(found.timestamp ?? '')),
    };
  }

  /** Instagram offers no deletion of posts through the API; the user deletes them in the app. */
  deletePost(): Promise<void> {
    return Promise.reject(
      new PlatformError('VALIDATION_REJECTED', 'Instagram does not delete posts through the API'),
    );
  }

  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const token = await ctx.credentials.accessToken();
    return collectUntilLimited(refs, async (ref): Promise<PostMetricsResult> => {
      let fields: { like_count?: number; comments_count?: number } | null;
      try {
        ({ data: fields } = await this.http.request({
          operation: 'instagram.media.fields',
          method: 'GET',
          url: this.url(`${ref.externalPostId}?fields=like_count,comments_count`),
          headers: bearer(token),
          schema: instagramPostRawSchema.shape.instagram.shape.fields.unwrap(),
          signal: ctx.signal,
          rateLimit: { accountId: ctx.account.id },
          mapError: graphErrorOf('instagram.media.fields'),
        }));
      } catch (error) {
        if (isNotFound(error)) {
          return { kind: 'deleted', externalPostId: ref.externalPostId };
        }
        throw error;
      }
      const raw = { instagram: { fields, insights: await this.insightsOf(ref.externalPostId, token, ctx) } };
      return {
        kind: 'metrics',
        externalPostId: ref.externalPostId,
        metrics: normalizeInstagramPostMetrics(raw),
        raw,
        mappingVersion: INSTAGRAM_MAP_VERSION,
      };
    });
  }

  async fetchAccountMetrics(
    _range: { from: Date; to: Date },
    ctx: AdapterContext,
  ): Promise<AccountMetricsResult> {
    const token = await ctx.credentials.accessToken();
    const { data } = await this.http.request({
      operation: 'instagram.account',
      method: 'GET',
      url: this.url(`${ctx.account.externalId}?fields=followers_count`),
      headers: bearer(token),
      schema: followersSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: graphErrorOf('instagram.account'),
    });
    const raw = { meta: { followers: data.followers_count ?? null }, account: data };
    return { ...normalizeMetaAccountMetrics(raw), raw, mappingVersion: INSTAGRAM_MAP_VERSION };
  }

  private url(path: string): string {
    return `${INSTAGRAM_GRAPH_URL}/${this.config.graphVersion}/${path}`;
  }

  /** Fails with RATE_LIMITED when the posts of the last 24 hours reached the limit. */
  private async checkLimit(user: string, token: string, ctx: AdapterContext): Promise<void> {
    const { data } = await this.http.request({
      operation: 'instagram.publishing_limit',
      method: 'GET',
      url: this.url(`${user}/content_publishing_limit?fields=quota_usage,config`),
      headers: bearer(token),
      schema: limitSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: graphErrorOf('instagram.publishing_limit'),
    });
    const [entry] = data.data;
    const total = entry?.config?.quota_total;
    if (entry?.quota_usage !== undefined && total !== undefined && entry.quota_usage >= total) {
      throw new PlatformError('RATE_LIMITED', 'The Instagram publishing limit of 24 hours is reached', {
        retryAfterMs: LIMIT_WAIT_MS,
      });
    }
  }

  /**
   * A container creates nothing visible, so it may be created again. Refused with an alt text,
   * it is created once more without: the alt text must never stop a post (ADR 0046).
   */
  private async createContainer(
    user: string,
    form: Record<string, string>,
    token: string,
    ctx: AdapterContext,
  ): Promise<string> {
    const create = async (fields: Record<string, string>): Promise<string> => {
      const { data } = await this.http.request({
        operation: 'instagram.media.create',
        method: 'POST',
        url: this.url(`${user}/media`),
        headers: bearer(token),
        body: { form: fields },
        schema: idSchema,
        idempotent: true,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('instagram.media.create'),
      });
      return data.id;
    };
    const { alt_text: altText, ...withoutAltText } = form;
    try {
      return await create(form);
    } catch (error) {
      if (altText === undefined || !isPlatformError(error) || error.code !== 'VALIDATION_REJECTED') {
        throw error;
      }
      ctx.logger.warn(
        { platform: 'INSTAGRAM', platformCode: error.platformCode ?? null },
        'instagram.alt_text_refused',
      );
      return create(withoutAltText);
    }
  }

  private async waitUntilFinished(container: string, token: string, ctx: AdapterContext): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    for (const wait of [0, ...CONTAINER_POLL_MS]) {
      if (wait > 0) {
        await ctx.keepAlive();
        await sleep(wait, ctx.signal);
      }
      const { data } = await this.http.request({
        operation: 'instagram.media.status',
        method: 'GET',
        url: this.url(`${container}?fields=status_code,status`),
        headers: bearer(token),
        schema: statusSchema,
        signal: ctx.signal,
        mapError: graphErrorOf('instagram.media.status'),
      });
      switch (data.status_code) {
        case 'FINISHED':
        case 'PUBLISHED':
          return;
        case 'ERROR':
        case 'EXPIRED':
          throw new PlatformError(
            'VALIDATION_REJECTED',
            `Instagram could not process the image (${data.status_code})`,
          );
        default:
          break;
      }
    }
    throw new PlatformError('MEDIA_PROCESSING', 'Instagram is still processing the post');
  }

  private async permalinkOf(mediaId: string, token: string, ctx: AdapterContext): Promise<string | null> {
    try {
      const { data } = await this.http.request({
        operation: 'instagram.media.permalink',
        method: 'GET',
        url: this.url(`${mediaId}?fields=permalink`),
        headers: bearer(token),
        schema: permalinkSchema,
        signal: ctx.signal,
        mapError: graphErrorOf('instagram.media.permalink'),
      });
      return data.permalink ?? null;
    } catch {
      // The post is out; the link is only a convenience.
      return null;
    }
  }

  /** The insights of a post; null when Instagram refuses them, for example for a renamed metric. */
  private async insightsOf(
    mediaId: string,
    token: string,
    ctx: AdapterContext,
  ): Promise<Record<string, number> | null> {
    try {
      const { data } = await this.http.request({
        operation: 'instagram.media.insights',
        method: 'GET',
        url: this.url(`${mediaId}/insights?metric=${INSTAGRAM_MEDIA_INSIGHTS.join(',')}`),
        headers: bearer(token),
        schema: insightsAnswerSchema,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('instagram.media.insights'),
      });
      return insightValues(data);
    } catch (error) {
      if (isPlatformError(error) && error.code === 'VALIDATION_REJECTED') {
        return null;
      }
      throw error;
    }
  }

  /** The first comment; the post is out already, so a failure is only logged. */
  private async comment(mediaId: string, message: string, token: string, ctx: AdapterContext): Promise<void> {
    try {
      await this.http.request({
        operation: 'instagram.comments.create',
        method: 'POST',
        url: this.url(`${mediaId}/comments`),
        headers: bearer(token),
        body: { form: { message } },
        idempotent: false,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('instagram.comments.create'),
      });
    } catch (error) {
      ctx.logger.warn(
        { platform: 'INSTAGRAM', code: isPlatformError(error) ? error.code : 'unknown' },
        'instagram.first_comment_failed',
      );
    }
  }
}
