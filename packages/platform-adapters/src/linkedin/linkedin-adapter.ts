import {
  isPlatformError,
  PlatformError,
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
  collectUntilLimited,
  defaultSleep,
  downloadMedia,
  sameText,
  type LiveAdapterDeps,
} from '../live/live-support';
import {
  encodeUrn,
  LINKEDIN_API_URL,
  linkedInErrorOf,
  restHeaders,
  type LinkedInAppConfig,
} from './linkedin-api';
import { LinkedInConnector } from './linkedin-connector';
import { fromLittleText, toLittleText } from './little-text';
import {
  LINKEDIN_MAP_VERSION,
  MEMBER_METRIC_TYPES,
  normalizeLinkedInAccountMetrics,
  normalizeLinkedInPostMetrics,
  shareStatisticsSchema,
  type LinkedInPostRaw,
} from './metrics-map';

// The LinkedIn adapter (guide step 4.12, architecture 4.2): posts of a person or a company page
// through the Posts API, images through the Images API (initializeUpload, PUT, wait until
// AVAILABLE). Every call carries the pinned LinkedIn-Version. The post id comes from x-restli-id.
// A personal post cannot be found again without a restricted read permission, so its reconcile
// finds nothing and an unclear attempt goes to NEEDS_ATTENTION; company pages search their posts.

const POSTS_URL = `${LINKEDIN_API_URL}/rest/posts`;
const IMAGES_URL = `${LINKEDIN_API_URL}/rest/images`;
/** The waits while LinkedIn processes an image, about 40 s in all. */
const IMAGE_POLL_MS = [1_000, 2_000, 3_000, 5_000, 5_000, 8_000, 8_000, 8_000];
/** The posts a reconcile of a company page looks through. */
const RECONCILE_POSTS = 20;
const APP = 'member';

const initializeUploadSchema = z.object({
  value: z.object({ uploadUrl: z.url(), image: z.string().startsWith('urn:li:image:') }),
});
const imageStatusSchema = z.object({ status: z.string() }).loose();
const postsByAuthorSchema = z.object({
  elements: z.array(
    z
      .object({
        id: z.string(),
        commentary: z.string().optional(),
        createdAt: z.number().optional(),
        publishedAt: z.number().optional(),
      })
      .loose(),
  ),
});
const shareStatisticsAnswerSchema = z.object({
  elements: z.array(
    z
      .object({
        share: z.string().optional(),
        ugcPost: z.string().optional(),
        totalShareStatistics: shareStatisticsSchema,
      })
      .loose(),
  ),
});
const memberAnalyticsSchema = z.object({
  elements: z.array(z.object({ count: z.number().int().nonnegative() }).loose()),
});
const networkSizeSchema = z.object({ firstDegreeSize: z.number().int().nonnegative() }).loose();

const isOrganization = (urn: string): boolean => urn.startsWith('urn:li:organization:');

/** The feed URL of a post, by its share or ugcPost URN. */
export const linkedInPostUrl = (urn: string): string => `https://www.linkedin.com/feed/update/${urn}/`;

export class LinkedInAdapter implements SocialPlatformAdapter {
  readonly platform = 'LINKEDIN' as const;
  readonly method = 'API' as const;
  readonly connector: LinkedInConnector;
  private readonly http: PlatformHttpClient;

  constructor(
    private readonly config: LinkedInAppConfig,
    private readonly deps: LiveAdapterDeps,
  ) {
    this.http = new PlatformHttpClient({
      platform: 'LINKEDIN',
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.limiter ? { limiter: deps.limiter } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.connector = new LinkedInConnector(config, this.http, deps.clock);
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf('LINKEDIN');
  }

  /** LinkedIn renews only with a refresh token, which partners get; others connect again. */
  async refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome> {
    const refreshToken = await ctx.credentials.refreshToken();
    if (refreshToken === null) {
      return { status: 'not_supported' };
    }
    return { status: 'refreshed', tokens: await this.connector.refresh(refreshToken) };
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: 'LINKEDIN',
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
    const author = ctx.account.externalId;
    const headers = restHeaders(await ctx.credentials.accessToken(), this.config.version);
    const images: { id: string; altText: string | null }[] = [];
    for (const media of request.media) {
      images.push({ id: await this.uploadImage(media, author, headers, ctx), altText: media.altText });
    }
    const altOf = (altText: string | null): { altText?: string } =>
      altText === null || altText.length === 0 ? {} : { altText: altText.slice(0, 4086) };
    const [single] = images;
    const content =
      images.length > 1
        ? { multiImage: { images: images.map((image) => ({ id: image.id, ...altOf(image.altText) })) } }
        : single
          ? { media: { id: single.id, ...altOf(single.altText) } }
          : undefined;

    const response = await this.http.request({
      operation: 'linkedin.posts.create',
      method: 'POST',
      url: POSTS_URL,
      headers,
      body: {
        json: {
          author,
          commentary: toLittleText(request.text),
          visibility: 'PUBLIC',
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          ...(content ? { content } : {}),
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        },
      },
      idempotent: false,
      signal: ctx.signal,
      rateLimit: { app: APP, accountId: ctx.account.id },
      mapError: linkedInErrorOf('linkedin.posts.create'),
    });
    const urn = response.headers.get('x-restli-id');
    if (!urn) {
      // The post was created, but its id is missing: the reconcile has to find it.
      throw new PlatformError('OUTCOME_UNKNOWN', 'linkedin.posts.create answered without x-restli-id', {
        status: response.status,
      });
    }
    const publishedAt = this.deps.clock.now();
    if (request.firstComment !== null && request.firstComment.length > 0) {
      await this.comment(urn, author, request.firstComment, headers, ctx);
    }
    return { externalPostId: urn, externalUrl: linkedInPostUrl(urn), publishedAt };
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const author = ctx.account.externalId;
    if (!isOrganization(author)) {
      return null;
    }
    const headers = restHeaders(await ctx.credentials.accessToken(), this.config.version);
    let posts: z.infer<typeof postsByAuthorSchema>['elements'];
    try {
      const { data } = await this.http.request({
        operation: 'linkedin.posts.by_author',
        method: 'GET',
        url: `${POSTS_URL}?q=author&author=${encodeUrn(author)}&count=${String(RECONCILE_POSTS)}&sortBy=LAST_MODIFIED`,
        headers,
        schema: postsByAuthorSchema,
        signal: ctx.signal,
        rateLimit: { app: APP, accountId: ctx.account.id },
      });
      posts = data.elements;
    } catch (error) {
      if (isPlatformError(error) && error.code === 'PERMISSION_DENIED') {
        return null;
      }
      throw error;
    }
    const found = posts.find((post) => {
      const at = post.publishedAt ?? post.createdAt;
      return (
        at !== undefined &&
        at >= query.since.getTime() &&
        post.commentary !== undefined &&
        sameText(fromLittleText(post.commentary), query.text)
      );
    });
    if (!found) {
      return null;
    }
    return {
      externalPostId: found.id,
      externalUrl: linkedInPostUrl(found.id),
      publishedAt: new Date(found.publishedAt ?? found.createdAt ?? this.deps.clock.now().getTime()),
    };
  }

  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    const headers = restHeaders(await ctx.credentials.accessToken(), this.config.version);
    try {
      await this.http.request({
        operation: 'linkedin.posts.delete',
        method: 'DELETE',
        url: `${POSTS_URL}/${encodeUrn(ref.externalPostId)}`,
        headers: { ...headers, 'x-restli-method': 'DELETE' },
        signal: ctx.signal,
        rateLimit: { app: APP, accountId: ctx.account.id },
      });
    } catch (error) {
      // Gone already.
      if (isPlatformError(error) && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    if (refs.length === 0) {
      return [];
    }
    const headers = restHeaders(await ctx.credentials.accessToken(), this.config.version);
    if (isOrganization(ctx.account.externalId)) {
      return this.organizationMetrics(refs, headers, ctx);
    }
    return collectUntilLimited(refs, async (ref): Promise<PostMetricsResult> => {
      const raw: LinkedInPostRaw = this.config.memberAnalytics
        ? { linkedin: { kind: 'member', counts: await this.memberCounts(ref.externalPostId, headers, ctx) } }
        : { linkedin: { kind: 'none' } };
      return {
        kind: 'metrics',
        externalPostId: ref.externalPostId,
        metrics: normalizeLinkedInPostMetrics(raw),
        raw,
        mappingVersion: LINKEDIN_MAP_VERSION,
      };
    });
  }

  async fetchAccountMetrics(
    _range: { from: Date; to: Date },
    ctx: AdapterContext,
  ): Promise<AccountMetricsResult> {
    let followers: number | null = null;
    if (isOrganization(ctx.account.externalId)) {
      const headers = restHeaders(await ctx.credentials.accessToken(), this.config.version);
      const { data } = await this.http.request({
        operation: 'linkedin.network_size',
        method: 'GET',
        url: `${LINKEDIN_API_URL}/rest/networkSizes/${encodeUrn(ctx.account.externalId)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
        headers,
        schema: networkSizeSchema,
        signal: ctx.signal,
        rateLimit: { app: APP, accountId: ctx.account.id },
      });
      followers = data.firstDegreeSize;
    }
    const raw = { linkedin: { followers } };
    return { ...normalizeLinkedInAccountMetrics(raw), raw, mappingVersion: LINKEDIN_MAP_VERSION };
  }

  /** Uploads one image and waits until LinkedIn can show it; returns its URN. */
  private async uploadImage(
    media: PublishMedia,
    owner: string,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<string> {
    const bytes = await downloadMedia(media, {
      signal: ctx.signal,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
    const { data } = await this.http.request({
      operation: 'linkedin.images.initialize',
      method: 'POST',
      url: `${IMAGES_URL}?action=initializeUpload`,
      headers,
      body: { json: { initializeUploadRequest: { owner } } },
      schema: initializeUploadSchema,
      // An upload slot that is never used publishes nothing.
      idempotent: true,
      signal: ctx.signal,
      rateLimit: { app: APP, accountId: ctx.account.id },
    });
    await this.http.request({
      operation: 'linkedin.images.upload',
      method: 'PUT',
      url: data.value.uploadUrl,
      headers: { authorization: headers.authorization ?? '' },
      body: { bytes, contentType: media.mimeType },
      signal: ctx.signal,
    });
    const urn = data.value.image;
    const sleep = this.deps.sleep ?? defaultSleep;
    for (const wait of [0, ...IMAGE_POLL_MS]) {
      if (wait > 0) {
        await ctx.keepAlive();
        await sleep(wait, ctx.signal);
      }
      const { data: image } = await this.http.request({
        operation: 'linkedin.images.status',
        method: 'GET',
        url: `${IMAGES_URL}/${encodeUrn(urn)}`,
        headers,
        schema: imageStatusSchema,
        signal: ctx.signal,
      });
      if (image.status === 'AVAILABLE') {
        return urn;
      }
      if (image.status === 'PROCESSING_FAILED') {
        throw new PlatformError('VALIDATION_REJECTED', 'LinkedIn could not process the image');
      }
    }
    throw new PlatformError('MEDIA_PROCESSING', 'LinkedIn is still processing the image');
  }

  /** The first comment; the post is out already, so a failure is only logged. */
  private async comment(
    urn: string,
    actor: string,
    text: string,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<void> {
    try {
      await this.http.request({
        operation: 'linkedin.comments.create',
        method: 'POST',
        url: `${LINKEDIN_API_URL}/rest/socialActions/${encodeUrn(urn)}/comments`,
        headers,
        body: { json: { actor, object: urn, message: { text: toLittleText(text) } } },
        idempotent: false,
        signal: ctx.signal,
        rateLimit: { app: APP, accountId: ctx.account.id },
      });
    } catch (error) {
      ctx.logger.warn(
        { platform: 'LINKEDIN', code: isPlatformError(error) ? error.code : 'unknown' },
        'linkedin.first_comment_failed',
      );
    }
  }

  /** Share statistics of a company page, one call for the batch; a missing post is checked once. */
  private async organizationMetrics(
    refs: readonly ExternalPostRef[],
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const shares = refs.map((ref) => ref.externalPostId).filter((id) => id.startsWith('urn:li:share:'));
    const ugcPosts = refs.map((ref) => ref.externalPostId).filter((id) => id.startsWith('urn:li:ugcPost:'));
    const list = (urns: string[]): string => `List(${urns.map(encodeUrn).join(',')})`;
    const { data } = await this.http.request({
      operation: 'linkedin.share_statistics',
      method: 'GET',
      url:
        `${LINKEDIN_API_URL}/rest/organizationalEntityShareStatistics?q=organizationalEntity` +
        `&organizationalEntity=${encodeUrn(ctx.account.externalId)}` +
        (shares.length > 0 ? `&shares=${list(shares)}` : '') +
        (ugcPosts.length > 0 ? `&ugcPosts=${list(ugcPosts)}` : ''),
      headers,
      schema: shareStatisticsAnswerSchema,
      signal: ctx.signal,
      rateLimit: { app: APP, accountId: ctx.account.id },
    });
    const byUrn = new Map(
      data.elements.map((element) => [element.share ?? element.ugcPost ?? '', element.totalShareStatistics]),
    );
    const results: PostMetricsResult[] = [];
    for (const ref of refs) {
      const stats = byUrn.get(ref.externalPostId);
      if (stats) {
        const raw: LinkedInPostRaw = { linkedin: { kind: 'organization', totalShareStatistics: stats } };
        results.push({
          kind: 'metrics',
          externalPostId: ref.externalPostId,
          metrics: normalizeLinkedInPostMetrics(raw),
          raw,
          mappingVersion: LINKEDIN_MAP_VERSION,
        });
      } else if (await this.isDeleted(ref.externalPostId, headers, ctx)) {
        results.push({ kind: 'deleted', externalPostId: ref.externalPostId });
      }
    }
    return results;
  }

  private async isDeleted(
    urn: string,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<boolean> {
    try {
      await this.http.request({
        operation: 'linkedin.posts.get',
        method: 'GET',
        url: `${POSTS_URL}/${encodeUrn(urn)}`,
        headers,
        signal: ctx.signal,
        rateLimit: { app: APP, accountId: ctx.account.id },
      });
      return false;
    } catch (error) {
      if (isPlatformError(error) && (error.status === 404 || error.status === 410)) {
        return true;
      }
      throw error;
    }
  }

  /** The counters of a personal post, one call per metric type (Member Post Analytics). */
  private async memberCounts(
    urn: string,
    headers: Record<string, string>,
    ctx: AdapterContext,
  ): Promise<Partial<Record<(typeof MEMBER_METRIC_TYPES)[number], number>>> {
    const entity = urn.startsWith('urn:li:ugcPost:')
      ? `(ugcPost:${encodeUrn(urn)})`
      : `(share:${encodeUrn(urn)})`;
    const counts: Partial<Record<(typeof MEMBER_METRIC_TYPES)[number], number>> = {};
    for (const type of MEMBER_METRIC_TYPES) {
      const { data } = await this.http.request({
        operation: 'linkedin.member_post_analytics',
        method: 'GET',
        url: `${LINKEDIN_API_URL}/rest/memberCreatorPostAnalytics?q=entity&entity=${entity}&queryType=${type}&aggregation=TOTAL`,
        headers,
        schema: memberAnalyticsSchema,
        signal: ctx.signal,
        rateLimit: { app: APP, accountId: ctx.account.id },
      });
      const total = data.elements.reduce((sum, element) => sum + element.count, 0);
      counts[type] = total;
    }
    return counts;
  }
}
