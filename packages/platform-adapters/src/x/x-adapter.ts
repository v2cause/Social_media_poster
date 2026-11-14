import {
  isPlatformError,
  type AccountMetricsResult,
  type AdapterContext,
  type ExternalPostRef,
  type PostMetricsResult,
  type PublishMedia,
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
import { blobOf, downloadMedia, hasLink, normalizedText, type LiveAdapterDeps } from '../live/live-support';
import {
  normalizeXAccountMetrics,
  normalizeXPostMetrics,
  publicMetricsSchema,
  X_MAP_VERSION,
} from './metrics-map';
import { bearer, X_API_URL, xErrorOf, type XAppConfig } from './x-api';
import { XConnector } from './x-connector';

// The adapter of the X API (guide step 4.14, architecture 4.2): images through the media upload
// of v2 with their alt text, then POST /2/tweets. X charges per call (pay-per-use), so every paid
// call is recorded with its operation (prices.ts): a post, a post with a link, every post read.
// A reconcile reads the latest five posts only, because reading costs too.

/** The fewest posts the timeline endpoint returns, and all a reconcile reads. */
const RECONCILE_POSTS = 5;
/** The most ids one lookup takes. */
const LOOKUP_IDS = 100;
/** The longest alt text X keeps. */
const ALT_TEXT_MAX = 1000;

const createdSchema = z.object({ data: z.object({ id: z.string().min(1) }).loose() });
const uploadSchema = z.object({ data: z.object({ id: z.string().min(1) }).loose() });
const timelineSchema = z.object({
  data: z
    .array(z.object({ id: z.string(), text: z.string(), created_at: z.string().optional() }).loose())
    .optional(),
});
const lookupSchema = z.object({
  data: z.array(z.object({ id: z.string(), public_metrics: publicMetricsSchema }).loose()).optional(),
  errors: z
    .array(
      z
        .object({
          resource_id: z.string().optional(),
          value: z.string().optional(),
          type: z.string().optional(),
        })
        .loose(),
    )
    .optional(),
});
const userMetricsSchema = z.object({
  data: z
    .object({
      public_metrics: z
        .object({ followers_count: z.number().int().nonnegative().optional() })
        .loose()
        .optional(),
    })
    .loose(),
});

/** X shortens every link to t.co, so a reconcile compares texts without links. */
const withoutLinks = (text: string): string => normalizedText(text.replace(/\bhttps?:\/\/\S+/gi, ''));

export const xPostUrl = (handle: string | null, id: string): string =>
  handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;

export class XApiAdapter implements SocialPlatformAdapter {
  readonly platform = 'X' as const;
  readonly method = 'API' as const;
  readonly connector: XConnector;
  private readonly http: PlatformHttpClient;

  constructor(
    config: XAppConfig,
    private readonly deps: LiveAdapterDeps,
  ) {
    this.http = new PlatformHttpClient({
      platform: 'X',
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.limiter ? { limiter: deps.limiter } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.connector = new XConnector(config, this.http, deps.clock);
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('X');
  }

  async refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome> {
    const refreshToken = await ctx.credentials.refreshToken();
    if (refreshToken === null) {
      return { status: 'not_supported' };
    }
    return { status: 'refreshed', tokens: await this.connector.refresh(refreshToken) };
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: 'X',
      text: request.text,
      firstComment: request.firstComment,
      media: request.media.map((item) => ({
        kind: item.mimeType === 'image/gif' ? 'gif' : 'image',
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
    const token = await ctx.credentials.accessToken();
    const mediaIds: string[] = [];
    for (const media of request.media) {
      mediaIds.push(await this.upload(media, token, ctx));
    }
    const { data } = await this.http.request({
      operation: 'x.tweets.create',
      method: 'POST',
      url: `${X_API_URL}/2/tweets`,
      headers: bearer(token),
      body: {
        json: { text: request.text, ...(mediaIds.length > 0 ? { media: { media_ids: mediaIds } } : {}) },
      },
      schema: createdSchema,
      idempotent: false,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: xErrorOf('x.tweets.create'),
    });
    await ctx.costs.record({
      operation:
        request.linkUrl !== null || hasLink(request.text) ? 'x.post_create_with_url' : 'x.post_create',
    });
    return {
      externalPostId: data.data.id,
      externalUrl: xPostUrl(ctx.account.handle, data.data.id),
      publishedAt: this.deps.clock.now(),
    };
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const token = await ctx.credentials.accessToken();
    const params = new URLSearchParams({
      max_results: String(RECONCILE_POSTS),
      'tweet.fields': 'created_at',
      start_time: query.since.toISOString(),
      exclude: 'replies,retweets',
    });
    const { data } = await this.http.request({
      operation: 'x.users.tweets',
      method: 'GET',
      url: `${X_API_URL}/2/users/${encodeURIComponent(ctx.account.externalId)}/tweets?${params.toString()}`,
      headers: bearer(token),
      schema: timelineSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: xErrorOf('x.users.tweets'),
    });
    const posts = data.data ?? [];
    if (posts.length > 0) {
      await ctx.costs.record({ operation: 'x.post_read', units: posts.length });
    }
    const wanted = withoutLinks(query.text);
    const found = posts.find((post) => withoutLinks(post.text) === wanted);
    if (!found) {
      return null;
    }
    return {
      externalPostId: found.id,
      externalUrl: xPostUrl(ctx.account.handle, found.id),
      publishedAt: found.created_at ? new Date(found.created_at) : this.deps.clock.now(),
    };
  }

  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    const token = await ctx.credentials.accessToken();
    try {
      await this.http.request({
        operation: 'x.tweets.delete',
        method: 'DELETE',
        url: `${X_API_URL}/2/tweets/${encodeURIComponent(ref.externalPostId)}`,
        headers: bearer(token),
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: xErrorOf('x.tweets.delete'),
      });
    } catch (error) {
      if (isPlatformError(error) && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  /** One lookup per 100 posts; a post X names as not found is deleted. Every post read costs. */
  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const token = await ctx.credentials.accessToken();
    const results: PostMetricsResult[] = [];
    for (let start = 0; start < refs.length; start += LOOKUP_IDS) {
      const ids = refs.slice(start, start + LOOKUP_IDS).map((ref) => ref.externalPostId);
      const params = new URLSearchParams({ ids: ids.join(','), 'tweet.fields': 'public_metrics' });
      const { data } = await this.http.request({
        operation: 'x.tweets.lookup',
        method: 'GET',
        url: `${X_API_URL}/2/tweets?${params.toString()}`,
        headers: bearer(token),
        schema: lookupSchema,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: xErrorOf('x.tweets.lookup'),
      });
      const found = data.data ?? [];
      if (found.length > 0) {
        await ctx.costs.record({ operation: 'x.post_read', units: found.length });
      }
      for (const post of found) {
        const raw = { x: { public_metrics: post.public_metrics } };
        results.push({
          kind: 'metrics',
          externalPostId: post.id,
          metrics: normalizeXPostMetrics(raw),
          raw,
          mappingVersion: X_MAP_VERSION,
        });
      }
      for (const error of data.errors ?? []) {
        const id = error.resource_id ?? error.value;
        if (id !== undefined && ids.includes(id) && /not-found/i.test(error.type ?? '')) {
          results.push({ kind: 'deleted', externalPostId: id });
        }
      }
    }
    return results;
  }

  async fetchAccountMetrics(
    _range: { from: Date; to: Date },
    ctx: AdapterContext,
  ): Promise<AccountMetricsResult> {
    const token = await ctx.credentials.accessToken();
    const { data } = await this.http.request({
      operation: 'x.users.me.metrics',
      method: 'GET',
      url: `${X_API_URL}/2/users/me?user.fields=public_metrics`,
      headers: bearer(token),
      schema: userMetricsSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: xErrorOf('x.users.me.metrics'),
    });
    const raw = { x: { followers_count: data.data.public_metrics?.followers_count ?? null } };
    return { ...normalizeXAccountMetrics(raw), raw, mappingVersion: X_MAP_VERSION };
  }

  /** Uploads an image in one request and sets its alt text; returns the media id. */
  private async upload(media: PublishMedia, token: string, ctx: AdapterContext): Promise<string> {
    const bytes = await downloadMedia(media, {
      signal: ctx.signal,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    const form = new FormData();
    form.set('media', blobOf(bytes, media.mimeType), 'media');
    form.set('media_category', media.mimeType === 'image/gif' ? 'tweet_gif' : 'tweet_image');
    form.set('media_type', media.mimeType);
    const { data } = await this.http.request({
      operation: 'x.media.upload',
      method: 'POST',
      url: `${X_API_URL}/2/media/upload`,
      headers: bearer(token),
      body: { multipart: form },
      schema: uploadSchema,
      // An uploaded image that no post uses is never shown.
      idempotent: true,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: xErrorOf('x.media.upload'),
    });
    const id = data.data.id;
    if (media.altText !== null && media.altText.length > 0) {
      await this.describe(id, media.altText, token, ctx);
    }
    return id;
  }

  /**
   * The alt text of an uploaded image. It must never stop a post: a refusal is logged and the image
   * goes out without one. An expired token still fails, so the job renews it (ADR 0046).
   */
  private async describe(id: string, altText: string, token: string, ctx: AdapterContext): Promise<void> {
    try {
      await this.http.request({
        operation: 'x.media.metadata',
        method: 'POST',
        url: `${X_API_URL}/2/media/metadata`,
        headers: bearer(token),
        body: { json: { id, metadata: { alt_text: { text: altText.slice(0, ALT_TEXT_MAX) } } } },
        idempotent: true,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: xErrorOf('x.media.metadata'),
      });
    } catch (error) {
      if (!isPlatformError(error) || error.code === 'AUTH_EXPIRED' || error.retryable) {
        throw error;
      }
      ctx.logger.warn(
        { platform: 'X', code: error.code, status: error.status ?? null },
        'x.alt_text_refused',
      );
    }
  }
}
