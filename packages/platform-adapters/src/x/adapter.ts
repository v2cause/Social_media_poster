import {
  isPlatformError,
  PlatformError,
  type AccountMetricsResult,
  type AdapterContext,
  type DateRange,
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

import type { PlatformHttpClient } from '../http/platform-http-client';
import { tokenSetOf, XOAuthConnector } from './connector';
import { MAP_VERSION, normalizeXAccountMetrics, normalizeXPostMetrics } from './metrics-map';
import { isUploadableMimeType, XMediaUploader } from './media-upload';
import { basicAuthOf, type ResolvedXConfig } from './x-config';
import { postCreateOperation, X_COST_OPERATIONS } from './x-costs';
import { mapXApiError, mapXTokenError, problemTypeOf } from './x-errors';
import {
  createPostSchema,
  deletePostSchema,
  postsLookupSchema,
  tokenResponseSchema,
  userPostsSchema,
  usersMeSchema,
  type XPost,
} from './x-schemas';

// The X API adapter (guide step 4.14, architecture 4.2): posts with images through API v2,
// reconcile over the latest own posts, metrics in batches of 100, followers, rotating refresh
// tokens. Endpoints, checked 2026-11-25 against https://docs.x.com/openapi.json 2.175 and the
// pages named below:
// - POST /2/tweets {text, media: {media_ids}} answers 201 {data: {id, text}}; up to 4 photos or
//   1 GIF; text up to 280 characters without Premium (https://docs.x.com/x-api/posts/create-post).
//   Self-serve apps may reply only when summoned and use at most 1 cashtag per post
//   (https://docs.x.com/x-api/posts/manage-tweets/integrate).
// - DELETE /2/tweets/:id answers {data: {deleted}}.
// - GET /2/users/:id/tweets with max_results from 5 to 100, exclude, tweet.fields.
// - GET /2/tweets?ids= with up to 100 ids; missing posts come back in errors with the type
//   .../resource-not-found (https://docs.x.com/x-api/fundamentals/response-codes-and-errors,
//   "Partial errors").
// - GET /2/users/me with user.fields=public_metrics.
// - Rate limits per user per 15 minutes: POST /2/tweets 100 (and 10,000 per app per 24 hours),
//   DELETE /2/tweets/:id 50, GET /2/users/:id/tweets 900, GET /2/tweets 5,000, GET /2/users/me 75
//   (https://docs.x.com/x-api/fundamentals/rate-limits). The integration guide of the manage
//   endpoints names 200 per 15 minutes and 300 per 3 hours for creating posts instead; the lower
//   numbers count. A 429 carries x-rate-limit-reset (epoch seconds), read by rate-headers.ts.
//
// The field list parameter: the prose pages (https://docs.x.com/x-api/fundamentals/fields,
// .../metrics) use tweet.fields; the OpenAPI document 2.175 names it post.fields for these
// operations and tweet.fields for others. The adapter sends tweet.fields, the documented name,
// which the versioning policy keeps until a new major version
// (https://docs.x.com/x-api/fundamentals/versioning, "Removing a query parameter" is breaking).

/** Reads cost money, so the reconcile looks at the latest own posts only (guide step 4.14). */
export const X_RECONCILE_POSTS = 5;
/** GET /2/tweets takes up to 100 ids (guide step 5.2: X batches of 100). */
export const X_METRICS_BATCH = 100;
/** X answers created_at in seconds; a post can carry a time a little before the attempt began. */
const RECONCILE_TOLERANCE_MS = 60_000;

const NOT_FOUND = 'resource-not-found';

/** The text as it goes out: the link goes at the end when the text does not carry it yet. */
export const xTextOf = (request: Pick<PublishRequest, 'text' | 'linkUrl'>): string =>
  request.linkUrl === null || request.text.includes(request.linkUrl)
    ? request.text
    : `${request.text.trimEnd()}\n\n${request.linkUrl}`;

const decodeEntities = (text: string): string =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Text for the comparison in the reconcile: X returns &, < and > as HTML entities, replaces every
 * URL by a t.co link and appends a t.co link for attached media. All URLs become one placeholder,
 * trailing ones are dropped, whitespace is collapsed.
 */
export const comparableText = (text: string): string =>
  decodeEntities(text)
    .normalize('NFC')
    .replace(/https?:\/\/\S+/g, '\uFFFC')
    .replace(/(?:\s*\uFFFC)+\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();

export class XApiAdapter implements SocialPlatformAdapter {
  readonly platform = 'X' as const;
  readonly method = 'API' as const;
  readonly connector: XOAuthConnector;
  private readonly media: XMediaUploader;

  constructor(
    private readonly config: ResolvedXConfig,
    private readonly http: PlatformHttpClient,
  ) {
    this.connector = new XOAuthConnector(config, http);
    this.media = new XMediaUploader(config, http);
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('X');
  }

  /**
   * Renews with the refresh token, which is single-use: the caller holds the lock of the
   * connection and stores the new token set before anything else uses it. POST /2/oauth2/token
   * with grant_type=refresh_token and HTTP Basic (checked 2026-11-25,
   * https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token, Step 5). A lost
   * answer is OUTCOME_UNKNOWN: the old token may be used up already.
   */
  async refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome> {
    const refreshToken = await ctx.credentials.refreshToken();
    if (refreshToken === null) {
      // Without offline.access X issues no refresh token.
      return { status: 'not_supported' };
    }
    const { data } = await this.http.request({
      operation: 'x.oauth.refresh',
      method: 'POST',
      url: `${this.config.apiBaseUrl}/2/oauth2/token`,
      headers: { authorization: basicAuthOf(this.config) },
      body: { form: { grant_type: 'refresh_token', refresh_token: refreshToken } },
      schema: tokenResponseSchema,
      idempotent: false,
      signal: ctx.signal,
      mapError: mapXTokenError('x.oauth.refresh', this.now, 'AUTH_EXPIRED'),
    });
    return { status: 'refreshed', tokens: tokenSetOf(data, this.config.clock.now()) };
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    const issues = validatePost({
      platform: 'X',
      text: xTextOf(request),
      firstComment: request.firstComment,
      media: request.media.map((item) => ({
        kind: item.mimeType === 'image/gif' ? 'gif' : item.mimeType.startsWith('video/') ? 'video' : 'image',
        mimeType: item.mimeType,
        width: item.width,
        height: item.height,
      })),
    });
    // Video is in the capabilities of X but not uploaded by this adapter yet.
    request.media.forEach((item, mediaIndex) => {
      if (!isUploadableMimeType(item.mimeType) && !issues.some((issue) => issue.mediaIndex === mediaIndex)) {
        issues.push({ code: 'UNSUPPORTED_MEDIA_TYPE', mediaIndex });
      }
    });
    return issues;
  }

  async publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult> {
    if (ctx.dryRun) {
      throw new Error('A dry run must not reach publish.');
    }
    const accessToken = await ctx.credentials.accessToken();
    const mediaIds: string[] = [];
    for (const item of request.media) {
      mediaIds.push(await this.media.upload(item, accessToken, ctx));
    }
    await ctx.keepAlive();
    const text = xTextOf(request);
    const { data } = await this.http.request({
      operation: 'x.posts.create',
      method: 'POST',
      url: `${this.config.apiBaseUrl}/2/tweets`,
      headers: this.auth(accessToken),
      body: { json: mediaIds.length > 0 ? { text, media: { media_ids: mediaIds } } : { text } },
      schema: createPostSchema,
      idempotent: false,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: mapXApiError('x.posts.create', this.now),
    });
    await ctx.costs.record({ operation: postCreateOperation(text) });
    return {
      externalPostId: data.data.id,
      externalUrl: this.urlOf(data.data.id, ctx),
      publishedAt: this.config.clock.now(),
      ...(mediaIds.length > 0 ? { meta: { mediaIds } } : {}),
    };
  }

  /**
   * Reads the latest 5 own posts (GET /2/users/:id/tweets, without replies and reposts) and looks
   * for the text since the given time. Each post returned is billed; when the connected account
   * owns the developer app, as Owned Read. A post found was created and billed by the earlier
   * attempt, whose costs were never recorded, so its create is recorded here.
   */
  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const accessToken = await ctx.credentials.accessToken();
    const params = new URLSearchParams({
      max_results: String(X_RECONCILE_POSTS),
      exclude: 'replies,retweets',
      'tweet.fields': 'created_at,text',
    });
    const { data } = await this.http.request({
      operation: 'x.posts.own',
      method: 'GET',
      url: `${this.config.apiBaseUrl}/2/users/${encodeURIComponent(ctx.account.externalId)}/tweets?${params.toString()}`,
      headers: this.auth(accessToken),
      schema: userPostsSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: mapXApiError('x.posts.own', this.now),
    });
    const posts = (data.data ?? []).slice(0, X_RECONCILE_POSTS);
    if (posts.length > 0) {
      await ctx.costs.record({
        operation:
          this.config.ownerUserId === ctx.account.externalId
            ? X_COST_OPERATIONS.ownedPostRead
            : X_COST_OPERATIONS.postRead,
        units: posts.length,
      });
    }
    const wanted = comparableText(query.text);
    const earliest = query.since.getTime() - RECONCILE_TOLERANCE_MS;
    const found = posts.find((post) => this.matches(post, wanted, earliest));
    if (!found) {
      return null;
    }
    await ctx.costs.record({ operation: postCreateOperation(decodeEntities(found.text ?? query.text)) });
    return {
      externalPostId: found.id,
      externalUrl: this.urlOf(found.id, ctx),
      publishedAt: found.created_at === undefined ? this.config.clock.now() : new Date(found.created_at),
    };
  }

  /** DELETE /2/tweets/:id; a post X no longer knows counts as deleted. */
  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    const accessToken = await ctx.credentials.accessToken();
    let deleted: boolean;
    try {
      const { data } = await this.http.request({
        operation: 'x.posts.delete',
        method: 'DELETE',
        url: `${this.config.apiBaseUrl}/2/tweets/${encodeURIComponent(ref.externalPostId)}`,
        headers: this.auth(accessToken),
        schema: deletePostSchema,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: mapXApiError('x.posts.delete', this.now),
      });
      deleted = data.data.deleted;
    } catch (error) {
      if (isPlatformError(error) && error.status === 404) {
        return;
      }
      throw error;
    }
    if (!deleted) {
      throw new PlatformError('TRANSIENT', 'X did not delete the post');
    }
    await ctx.costs.record({ operation: X_COST_OPERATIONS.postDelete });
  }

  /**
   * GET /2/tweets with public_metrics, up to 100 ids per call. A post in errors with the type
   * resource-not-found is deleted; one without an answer is asked for again later. Every post
   * returned is billed as Posts: Read.
   */
  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const accessToken = await ctx.credentials.accessToken();
    const results: PostMetricsResult[] = [];
    for (let start = 0; start < refs.length; start += X_METRICS_BATCH) {
      const batch = refs.slice(start, start + X_METRICS_BATCH);
      const params = new URLSearchParams({
        ids: batch.map((ref) => ref.externalPostId).join(','),
        'tweet.fields': 'public_metrics,created_at',
      });
      const { data } = await this.http.request({
        operation: 'x.posts.lookup',
        method: 'GET',
        url: `${this.config.apiBaseUrl}/2/tweets?${params.toString()}`,
        headers: this.auth(accessToken),
        schema: postsLookupSchema,
        signal: ctx.signal,
        rateLimit: { accountId: ctx.account.id },
        mapError: mapXApiError('x.posts.lookup', this.now),
      });
      const found = new Map((data.data ?? []).map((post) => [post.id, post]));
      const missing = new Set(
        (data.errors ?? [])
          .filter((error) => problemTypeOf(error) === NOT_FOUND)
          .map((error) => error.resource_id ?? error.value)
          .filter((id): id is string => id !== undefined),
      );
      if (found.size > 0) {
        await ctx.costs.record({ operation: X_COST_OPERATIONS.postRead, units: found.size });
      }
      for (const ref of batch) {
        const post = found.get(ref.externalPostId);
        if (post) {
          results.push({
            kind: 'metrics',
            externalPostId: post.id,
            metrics: normalizeXPostMetrics(post),
            raw: post,
            mappingVersion: MAP_VERSION,
          });
        } else if (missing.has(ref.externalPostId)) {
          results.push({ kind: 'deleted', externalPostId: ref.externalPostId });
        }
      }
    }
    return results;
  }

  /** GET /2/users/me with public_metrics: X reports followers, no reach or profile views. */
  async fetchAccountMetrics(_range: DateRange, ctx: AdapterContext): Promise<AccountMetricsResult> {
    const accessToken = await ctx.credentials.accessToken();
    const { data } = await this.http.request({
      operation: 'x.users.me',
      method: 'GET',
      url: `${this.config.apiBaseUrl}/2/users/me?${new URLSearchParams({ 'user.fields': 'public_metrics' }).toString()}`,
      headers: this.auth(accessToken),
      schema: usersMeSchema,
      signal: ctx.signal,
      rateLimit: { accountId: ctx.account.id },
      mapError: mapXApiError('x.users.me', this.now),
    });
    await ctx.costs.record({ operation: X_COST_OPERATIONS.userRead });
    const raw = data.data;
    return { ...normalizeXAccountMetrics(raw), raw, mappingVersion: MAP_VERSION };
  }

  private matches(post: XPost, wanted: string, earliest: number): boolean {
    if (post.text === undefined || comparableText(post.text) !== wanted) {
      return false;
    }
    return post.created_at === undefined || Date.parse(post.created_at) >= earliest;
  }

  /** The public link of a post; with the handle where it is known. */
  private urlOf(postId: string, ctx: AdapterContext): string {
    const handle = ctx.account.handle?.replace(/^@/, '');
    return handle && /^[A-Za-z0-9_]{1,15}$/.test(handle)
      ? `https://x.com/${handle}/status/${postId}`
      : `https://x.com/i/web/status/${postId}`;
  }

  private auth(accessToken: string): Record<string, string> {
    return { authorization: `Bearer ${accessToken}` };
  }

  private readonly now = (): number => this.config.clock.now().getTime();
}
