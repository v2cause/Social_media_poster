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
import {
  blobOf,
  collectUntilLimited,
  downloadMedia,
  sameText,
  type LiveAdapterDeps,
} from '../live/live-support';
import { FacebookConnector, graphUrl } from './facebook-connector';
import { bearer, graphErrorOf, idSchema, isNotFound, type MetaAppConfig } from './graph-api';
import {
  FACEBOOK_MAP_VERSION,
  FACEBOOK_POST_INSIGHTS,
  facebookPostRawSchema,
  insightsAnswerSchema,
  insightValues,
  normalizeFacebookPostMetrics,
  normalizeMetaAccountMetrics,
} from './metrics-map';

// The Facebook pages adapter (guide step 4.13, architecture 4.2): a text post to /{page}/feed,
// one photo to /{page}/photos, several photos uploaded unpublished and attached to one feed post.
// The photos go up as files, so the storage need not be public for Facebook. Every call uses the
// token of the page. Facebook shows a post at facebook.com/{post id}.

const photoSchema = z.object({ id: z.string().min(1), post_id: z.string().min(1).optional() }).loose();
const pagePostsSchema = z.object({
  data: z.array(
    z.object({ id: z.string(), message: z.string().optional(), created_time: z.string().optional() }).loose(),
  ),
});
const pageSchema = z
  .object({
    followers_count: z.number().int().nonnegative().optional(),
    fan_count: z.number().int().nonnegative().optional(),
  })
  .loose();
const POST_FIELDS = 'shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)';
/** The page posts a reconcile looks through. */
const RECONCILE_POSTS = 20;

export const facebookPostUrl = (postId: string): string => `https://www.facebook.com/${postId}`;

export class FacebookAdapter implements SocialPlatformAdapter {
  readonly platform = 'FACEBOOK' as const;
  readonly method = 'API' as const;
  readonly connector: FacebookConnector;
  private readonly http: PlatformHttpClient;

  constructor(
    private readonly config: MetaAppConfig,
    private readonly deps: LiveAdapterDeps,
  ) {
    this.http = new PlatformHttpClient({
      platform: 'FACEBOOK',
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.limiter ? { limiter: deps.limiter } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.connector = new FacebookConnector(config, this.http, deps.clock);
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('FACEBOOK');
  }

  /** Page tokens do not expire; a new grant renews the data access (token monitor). */
  refreshCredentials(): Promise<RefreshOutcome> {
    return Promise.resolve({ status: 'not_supported' });
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: 'FACEBOOK',
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
    const page = ctx.account.externalId;
    const token = await ctx.credentials.accessToken();
    let postId: string;
    const [single, ...more] = request.media;
    if (single && more.length === 0) {
      const { data } = await this.http.request({
        operation: 'facebook.photos.create',
        method: 'POST',
        url: graphUrl(this.config.graphVersion, `${page}/photos`),
        headers: bearer(token),
        body: { multipart: await this.photoForm(single, ctx, { message: request.text, published: 'true' }) },
        schema: photoSchema,
        idempotent: false,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('facebook.photos.create'),
      });
      postId = data.post_id ?? `${page}_${data.id}`;
    } else {
      const form: Record<string, string> = { message: request.text };
      for (const [index, media] of request.media.entries()) {
        // Unpublished photos appear only with the feed post that attaches them.
        const { data } = await this.http.request({
          operation: 'facebook.photos.upload',
          method: 'POST',
          url: graphUrl(this.config.graphVersion, `${page}/photos`),
          headers: bearer(token),
          body: { multipart: await this.photoForm(media, ctx, { published: 'false' }) },
          schema: idSchema,
          idempotent: true,
          signal: ctx.signal,
          rateLimit: { accountId: ctx.account.id },
          mapError: graphErrorOf('facebook.photos.upload'),
        });
        form[`attached_media[${String(index)}]`] = JSON.stringify({ media_fbid: data.id });
      }
      if (request.linkUrl !== null && request.media.length === 0) {
        form.link = request.linkUrl;
      }
      const { data } = await this.http.request({
        operation: 'facebook.feed.create',
        method: 'POST',
        url: graphUrl(this.config.graphVersion, `${page}/feed`),
        headers: bearer(token),
        body: { form },
        schema: idSchema,
        idempotent: false,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('facebook.feed.create'),
      });
      postId = data.id;
    }
    const publishedAt = this.deps.clock.now();
    if (request.firstComment !== null && request.firstComment.length > 0) {
      await this.comment(postId, request.firstComment, token, ctx);
    }
    return { externalPostId: postId, externalUrl: facebookPostUrl(postId), publishedAt };
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const token = await ctx.credentials.accessToken();
    const { data } = await this.http.request({
      operation: 'facebook.posts.list',
      method: 'GET',
      url: graphUrl(
        this.config.graphVersion,
        `${ctx.account.externalId}/posts?fields=id,message,created_time&limit=${String(RECONCILE_POSTS)}`,
      ),
      headers: bearer(token),
      schema: pagePostsSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: graphErrorOf('facebook.posts.list'),
    });
    const found = data.data.find((post) => {
      const at = post.created_time === undefined ? Number.NaN : Date.parse(post.created_time);
      return at >= query.since.getTime() && sameText(post.message ?? '', query.text);
    });
    if (!found) {
      return null;
    }
    return {
      externalPostId: found.id,
      externalUrl: facebookPostUrl(found.id),
      publishedAt: new Date(Date.parse(found.created_time ?? '')),
    };
  }

  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    const token = await ctx.credentials.accessToken();
    try {
      await this.http.request({
        operation: 'facebook.posts.delete',
        method: 'DELETE',
        url: graphUrl(this.config.graphVersion, ref.externalPostId),
        headers: bearer(token),
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('facebook.posts.delete'),
      });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }

  /** The counters of each post and its insights; a post Facebook no longer knows is deleted. */
  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const token = await ctx.credentials.accessToken();
    return collectUntilLimited(refs, async (ref): Promise<PostMetricsResult> => {
      let fields: z.infer<typeof facebookPostRawSchema>['facebook']['fields'];
      try {
        ({ data: fields } = await this.http.request({
          operation: 'facebook.posts.fields',
          method: 'GET',
          url: graphUrl(
            this.config.graphVersion,
            `${ref.externalPostId}?fields=${encodeURIComponent(POST_FIELDS)}`,
          ),
          headers: bearer(token),
          schema: facebookPostRawSchema.shape.facebook.shape.fields,
          signal: ctx.signal,
          rateLimit: { accountId: ctx.account.id },
          mapError: graphErrorOf('facebook.posts.fields'),
        }));
      } catch (error) {
        if (isNotFound(error)) {
          return { kind: 'deleted', externalPostId: ref.externalPostId };
        }
        throw error;
      }
      const raw = { facebook: { fields, insights: await this.insightsOf(ref.externalPostId, token, ctx) } };
      return {
        kind: 'metrics',
        externalPostId: ref.externalPostId,
        metrics: normalizeFacebookPostMetrics(raw),
        raw,
        mappingVersion: FACEBOOK_MAP_VERSION,
      };
    });
  }

  async fetchAccountMetrics(
    _range: { from: Date; to: Date },
    ctx: AdapterContext,
  ): Promise<AccountMetricsResult> {
    const token = await ctx.credentials.accessToken();
    const { data } = await this.http.request({
      operation: 'facebook.page',
      method: 'GET',
      url: graphUrl(this.config.graphVersion, `${ctx.account.externalId}?fields=followers_count,fan_count`),
      headers: bearer(token),
      schema: pageSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: graphErrorOf('facebook.page'),
    });
    const raw = { meta: { followers: data.followers_count ?? data.fan_count ?? null }, page: data };
    return { ...normalizeMetaAccountMetrics(raw), raw, mappingVersion: FACEBOOK_MAP_VERSION };
  }

  private async photoForm(
    media: PublishMedia,
    ctx: AdapterContext,
    fields: Record<string, string>,
  ): Promise<FormData> {
    const bytes = await downloadMedia(media, {
      signal: ctx.signal,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      form.set(name, value);
    }
    if (media.altText !== null && media.altText.length > 0) {
      form.set('alt_text_custom', media.altText);
    }
    form.set('source', blobOf(bytes, media.mimeType), 'photo');
    return form;
  }

  /** The insights of a post; null when Facebook refuses them, for example for a renamed metric. */
  private async insightsOf(
    postId: string,
    token: string,
    ctx: AdapterContext,
  ): Promise<Record<string, number> | null> {
    try {
      const { data } = await this.http.request({
        operation: 'facebook.posts.insights',
        method: 'GET',
        url: graphUrl(
          this.config.graphVersion,
          `${postId}/insights?metric=${FACEBOOK_POST_INSIGHTS.join(',')}`,
        ),
        headers: bearer(token),
        schema: insightsAnswerSchema,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('facebook.posts.insights'),
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
  private async comment(postId: string, message: string, token: string, ctx: AdapterContext): Promise<void> {
    try {
      await this.http.request({
        operation: 'facebook.comments.create',
        method: 'POST',
        url: graphUrl(this.config.graphVersion, `${postId}/comments`),
        headers: bearer(token),
        body: { form: { message } },
        idempotent: false,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: graphErrorOf('facebook.comments.create'),
      });
    } catch (error) {
      ctx.logger.warn(
        { platform: 'FACEBOOK', code: isPlatformError(error) ? error.code : 'unknown' },
        'facebook.first_comment_failed',
      );
    }
  }
}
