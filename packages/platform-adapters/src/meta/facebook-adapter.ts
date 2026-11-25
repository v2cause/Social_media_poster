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
import { FacebookConnector, type FacebookConnectorOptions } from './facebook-connector';
import {
  FACEBOOK_MAP_VERSION,
  facebookPostFieldsSchema,
  graphInsightsSchema,
  normalizeFacebookAccountMetrics,
  normalizeFacebookPostMetrics,
  type GraphInsights,
} from './facebook-metrics-map';
import { GraphApi } from './graph-api';
import { loginConfigIdSchema, resolveMetaAppConfig, type MetaAppConfig } from './graph-config';
import { endsBatch, isMissingObject } from './graph-errors';
import { downloadMedia, FACEBOOK_PHOTO_MAX_BYTES, multipartBody } from './media-upload';
import { MetaLogin } from './meta-login';
import { graphId, mediaItemsOf, parseGraphTime, sameText, unixSeconds } from './meta-shared';

// The adapter of Facebook Pages (guide step 4.13, architecture 4.2). It publishes with the Page
// token of the account (ConnectableAccount.accessToken). Sources, checked 2026-11-25:
// - Text and link posts: POST /{page-id}/feed with message and link; reading /{page-id}/feed;
//   DELETE /{page-post-id}; "The URL, or permalink, for a Page post is
//   https://www.facebook.com/page_post_id":
//   https://developers.facebook.com/documentation/pages-api/posts
// - One photo: POST /{page-id}/photos with the file (multipart) and caption ("message":
//   "Deprecated. Please use the caption param instead."), answer { id, post_id }. Several photos:
//   each with published=false, then POST /{page-id}/feed with attached_media[i]={"media_fbid":..};
//   unpublished photos stay about 24 hours. alt_text_custom carries the alt text:
//   https://developers.facebook.com/docs/graph-api/reference/page/photos/
// - Errors: 190 means an invalid token (AUTH_EXPIRED), 506 a duplicate post (graph-errors.ts).
// The first comment is not sent yet: it needs pages_manage_engagement and POST /{post}/comments.

export interface FacebookAdapterConfig {
  app: MetaAppConfig;
  clock: Clock;
  /** A Facebook Login for Business configuration (optional; otherwise the scope parameter). */
  loginConfigId?: string;
  /** Overrides the requested permissions (FACEBOOK_SCOPES). */
  scopes?: FacebookConnectorOptions['scopes'];
  limiter?: PlatformRateLimiter;
  logger?: AdapterLogger;
  /** The fetch for the Graph API and the storage downloads; the global one by default. */
  fetch?: typeof fetch;
}

const createdSchema = z.object({ id: z.string().min(1) });
const photoSchema = z.object({ id: z.string().min(1), post_id: z.string().min(1).optional() });
const successSchema = z.object({ success: z.boolean() });

const feedSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      message: z.string().optional(),
      created_time: z.string().optional(),
      permalink_url: z.string().optional(),
      is_published: z.boolean().optional(),
    }),
  ),
});

const pageSchema = z.object({
  id: z.string(),
  followers_count: z.number().int().nonnegative().optional(),
  fan_count: z.number().int().nonnegative().optional(),
});

/** Feed posts a reconcile looks at; the feed returns at most 100 (Page feed reference). */
const RECONCILE_POSTS = 25;

const POST_FIELDS = 'id,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)';
const POST_INSIGHTS = 'post_media_view,post_total_media_view_unique,post_clicks';
const PAGE_INSIGHTS = 'page_total_media_view_unique,page_views_total';

const postUrl = (postId: string): string => `https://www.facebook.com/${postId}`;

export class FacebookAdapter implements SocialPlatformAdapter {
  readonly platform = 'FACEBOOK' as const;
  readonly method = 'API' as const;
  readonly connector: FacebookConnector;

  private readonly graph: GraphApi;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: FacebookAdapterConfig) {
    const app = resolveMetaAppConfig(config.app);
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    const http = new PlatformHttpClient({
      platform: 'FACEBOOK',
      limiter: config.limiter,
      logger: config.logger,
      fetch: this.fetchFn,
    });
    this.graph = new GraphApi(http, app);
    this.connector = new FacebookConnector(new MetaLogin(this.graph), {
      loginConfigId: loginConfigIdSchema.parse(config.loginConfigId),
      scopes: config.scopes,
    });
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('FACEBOOK');
  }

  /**
   * Page tokens from a long-lived user token have no expiry by time; once Meta refuses one (error
   * 190: password changed, app removed, role lost), only a new login helps.
   */
  refreshCredentials(): Promise<RefreshOutcome> {
    return Promise.resolve({ status: 'not_supported' });
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: 'FACEBOOK',
      text: request.text,
      firstComment: request.firstComment,
      media: mediaItemsOf(request),
    });
  }

  async publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult> {
    if (ctx.dryRun) {
      throw new Error('A dry run must not reach publish.');
    }
    if (request.media.some((item) => !item.mimeType.toLowerCase().startsWith('image/'))) {
      throw new PlatformError(
        'VALIDATION_REJECTED',
        'The Facebook adapter publishes photos only, no videos yet',
        {
          retryable: false,
        },
      );
    }
    const token = await ctx.credentials.accessToken();
    const pageId = graphId(ctx.account.externalId);
    const now = this.config.clock.now();

    if (request.media.length === 0) {
      const created = await this.graph.call({
        operation: 'facebook.feed.create',
        method: 'POST',
        path: `/${pageId}/feed`,
        token,
        form: { message: request.text, ...(request.linkUrl === null ? {} : { link: request.linkUrl }) },
        schema: createdSchema,
        idempotent: false,
        accountId: ctx.account.id,
        signal: ctx.signal,
      });
      return { externalPostId: created.id, externalUrl: postUrl(created.id), publishedAt: now };
    }

    const [single] = request.media;
    if (request.media.length === 1 && single !== undefined) {
      const photo = await this.uploadPhoto(single, { caption: request.text, published: 'true' }, token, ctx);
      const postId = photo.post_id ?? photo.id;
      return {
        externalPostId: postId,
        externalUrl: postUrl(postId),
        publishedAt: now,
        meta: { photoIds: [photo.id] },
      };
    }

    const photoIds: string[] = [];
    for (const media of request.media) {
      const photo = await this.uploadPhoto(media, { published: 'false' }, token, ctx);
      photoIds.push(photo.id);
    }
    ctx.logger.info({ platform: 'FACEBOOK', photoIds }, 'facebook.photos.uploaded');
    const form: Record<string, string> = { message: request.text };
    photoIds.forEach((id, index) => {
      form[`attached_media[${String(index)}]`] = JSON.stringify({ media_fbid: id });
    });
    const created = await this.graph.call({
      operation: 'facebook.feed.create',
      method: 'POST',
      path: `/${pageId}/feed`,
      token,
      form,
      schema: createdSchema,
      idempotent: false,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    return {
      externalPostId: created.id,
      externalUrl: postUrl(created.id),
      publishedAt: now,
      meta: { photoIds },
    };
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const token = await ctx.credentials.accessToken();
    const feed = await this.graph.call({
      operation: 'facebook.feed.list',
      method: 'GET',
      path: `/${graphId(ctx.account.externalId)}/feed`,
      token,
      query: {
        fields: 'id,message,created_time,permalink_url,is_published',
        since: unixSeconds(query.since),
        limit: String(RECONCILE_POSTS),
      },
      schema: feedSchema,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    for (const post of feed.data) {
      const createdAt = post.created_time === undefined ? null : parseGraphTime(post.created_time);
      if (
        post.is_published !== false &&
        createdAt !== null &&
        createdAt >= query.since &&
        sameText(post.message, query.text)
      ) {
        return {
          externalPostId: post.id,
          externalUrl: post.permalink_url ?? postUrl(post.id),
          publishedAt: createdAt,
        };
      }
    }
    return null;
  }

  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    const token = await ctx.credentials.accessToken();
    const answer = await this.graph.call({
      operation: 'facebook.post.delete',
      method: 'DELETE',
      path: `/${graphId(ref.externalPostId)}`,
      token,
      schema: successSchema,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    if (!answer.success) {
      throw new PlatformError('TRANSIENT', 'facebook.post.delete was not confirmed');
    }
  }

  /**
   * Two reads per post: the counters of the post, then its insights. A post Graph no longer knows
   * comes back as deleted; a post without an answer is asked for again later. Missing insights
   * (Pages under 100 likes) leave views, reach and clicks null.
   */
  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const token = await ctx.credentials.accessToken();
    const results: PostMetricsResult[] = [];
    for (const ref of refs) {
      try {
        const postId = graphId(ref.externalPostId);
        const post = await this.graph.call({
          operation: 'facebook.post.read',
          method: 'GET',
          path: `/${postId}`,
          token,
          query: { fields: POST_FIELDS },
          schema: facebookPostFieldsSchema,
          accountId: ctx.account.id,
          signal: ctx.signal,
        });
        const insights = await this.optionalInsights(
          `/${postId}/insights`,
          { metric: POST_INSIGHTS },
          token,
          ctx,
        );
        const raw = { facebook: { post, insights } };
        results.push({
          kind: 'metrics',
          externalPostId: ref.externalPostId,
          metrics: normalizeFacebookPostMetrics(raw),
          raw,
          mappingVersion: FACEBOOK_MAP_VERSION,
        });
      } catch (error) {
        if (isMissingObject(error)) {
          results.push({ kind: 'deleted', externalPostId: ref.externalPostId });
        } else if (endsBatch(error)) {
          throw error;
        } else {
          ctx.logger.warn(
            { platform: 'FACEBOOK', operation: 'facebook.post.read' },
            'facebook.metrics.skipped',
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
    const pageId = graphId(ctx.account.externalId);
    const page = await this.graph.call({
      operation: 'facebook.page.read',
      method: 'GET',
      path: `/${pageId}`,
      token,
      query: { fields: 'id,followers_count,fan_count' },
      schema: pageSchema,
      accountId: ctx.account.id,
      signal: ctx.signal,
    });
    const insights = await this.optionalInsights(
      `/${pageId}/insights`,
      { metric: PAGE_INSIGHTS, period: 'day', since: unixSeconds(range.from), until: unixSeconds(range.to) },
      token,
      ctx,
    );
    const raw = { facebook: { page, insights } };
    return { ...normalizeFacebookAccountMetrics(raw), raw, mappingVersion: FACEBOOK_MAP_VERSION };
  }

  private async uploadPhoto(
    media: PublishRequest['media'][number],
    fields: Record<string, string>,
    token: string,
    ctx: AdapterContext,
  ): Promise<z.infer<typeof photoSchema>> {
    const bytes = await downloadMedia(this.fetchFn, media, {
      maxBytes: FACEBOOK_PHOTO_MAX_BYTES,
      signal: ctx.signal,
    });
    const body = await multipartBody(
      { ...fields, ...(media.altText === null ? {} : { alt_text_custom: media.altText }) },
      { bytes, mimeType: media.mimeType },
    );
    return this.graph.call({
      operation: 'facebook.photo.upload',
      method: 'POST',
      path: `/${graphId(ctx.account.externalId)}/photos`,
      token,
      body,
      schema: photoSchema,
      // A published photo is a post; an unpublished one would only be a stray upload.
      idempotent: fields.published === 'false',
      accountId: ctx.account.id,
      signal: ctx.signal,
      timeoutMs: 120_000,
    });
  }

  /**
   * Insights or null: a missing read_insights or a small Page must not cost the counters of the
   * post. Only a refused token and a rate limit go through.
   */
  private async optionalInsights(
    path: string,
    query: Record<string, string>,
    token: string,
    ctx: AdapterContext,
  ): Promise<GraphInsights | null> {
    try {
      return await this.graph.call({
        operation: 'facebook.insights.read',
        method: 'GET',
        path,
        token,
        query,
        schema: graphInsightsSchema,
        accountId: ctx.account.id,
        signal: ctx.signal,
      });
    } catch (error) {
      if (isPlatformError(error) && (error.code === 'AUTH_EXPIRED' || error.code === 'RATE_LIMITED')) {
        throw error;
      }
      return null;
    }
  }
}

export function createFacebookAdapter(config: FacebookAdapterConfig): FacebookAdapter {
  return new FacebookAdapter(config);
}
