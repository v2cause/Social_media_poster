import { setTimeout as sleep } from 'node:timers/promises';

import {
  isPlatformError,
  PlatformError,
  type AccountMetricsResult,
  type AdapterContext,
  type Clock,
  type DateRange,
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

import type { PlatformHttpClient } from '../http/platform-http-client';
import type { LinkedInAppConfig } from './config';
import { LinkedInApi, type CallScope } from './linkedin-api';
import { LinkedInOAuthConnector } from './linkedin-oauth-connector';
import { fromLittleText, toLittleText } from './little-text';
import { downloadMedia } from './media-download';
import {
  MAP_VERSION,
  MEMBER_POST_METRICS,
  normalizeLinkedInAccountMetrics,
  normalizeLinkedInPostMetrics,
  type LinkedInAccountMetricsRaw,
  type LinkedInPostMetricsRaw,
  type MemberPostMetric,
} from './metrics-map';
import { POST_URN } from './schemas';

// The LinkedIn adapter (guide step 4.12, architecture 4.2): text and image posts of a personal
// profile with the self-serve products alone, company pages with the Community Management API.
// Posting is free of charge at LinkedIn, so no costs are recorded.
// Limits per day (UTC), checked 2026-11-25:
// - Share on LinkedIn: 150 requests per member, 100,000 per app;
//   https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
// - Sign In with OpenID Connect: 500 per member, 100,000 per app;
//   https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
// - Community Management Development tier: 500 per app, 100 per member;
//   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
// - all limits reset at midnight UTC; a 429 carries no documented wait.
//   https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits

/**
 * Images below 36,152,320 pixels in JPG, GIF or PNG. The docs name no byte limit; maxImageBytes is
 * an own guard against oversized downloads.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * (checked 2026-11-25)
 */
const MAX_IMAGE_PIXELS = 36_152_320;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
/**
 * altText: at most 4,086 characters (less than 120 recommended).
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * (checked 2026-11-25)
 */
const MAX_ALT_TEXT = 4086;
/** Waits between the status checks of an uploaded page image, about a minute in all. */
const IMAGE_POLL_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 5_000, 10_000, 15_000, 20_000];
/** The latest posts of a page the reconcile looks at (the finder returns up to 100). */
const RECONCILE_POSTS = 20;

const PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]+$/;
const ORGANIZATION_URN = /^urn:li:organization:\d+$/;

export interface LinkedInAdapterDependencies {
  http: PlatformHttpClient;
  clock: Clock;
  /** Reads the renditions from the storage; the fetch of Node by default. */
  mediaFetch?: typeof fetch;
  maxImageBytes?: number;
  /** The wait between image status checks; tests pass one that returns at once. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Author = { urn: string; kind: 'person' | 'organization' };

/**
 * The URL a member opens a post with: https://www.linkedin.com/feed/update/urn:li:ugcPost:<id>/ is
 * documented for ugcPost; the same form for share URNs is not stated in the docs.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * (checked 2026-11-25)
 */
const postUrlOf = (postUrn: string): string => `https://www.linkedin.com/feed/update/${postUrn}/`;

const truncate = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

export class LinkedInApiAdapter implements SocialPlatformAdapter {
  readonly platform = 'LINKEDIN' as const;
  readonly method = 'API' as const;
  readonly connector: LinkedInOAuthConnector;
  private readonly api: LinkedInApi;

  constructor(
    private readonly config: LinkedInAppConfig,
    private readonly deps: LinkedInAdapterDependencies,
  ) {
    this.connector = new LinkedInOAuthConnector(config, deps.http, deps.clock);
    this.api = new LinkedInApi(deps.http, config.version);
  }

  /** The same rules for profiles and pages. */
  capabilities(): PlatformCapabilities {
    return capabilitiesOf('LINKEDIN');
  }

  /**
   * Without a refresh token (every app without programmatic refresh tokens) the 60-day access token
   * cannot be renewed in the background: the member connects again before it ends.
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
   * https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
   * (checked 2026-11-25)
   */
  async refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome> {
    const refreshToken = await ctx.credentials.refreshToken();
    if (refreshToken === null) {
      return { status: 'not_supported' };
    }
    return { status: 'refreshed', tokens: await this.connector.refresh(refreshToken, ctx.signal) };
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

  /**
   * Uploads the images, then POST /rest/posts: one image as content.media, two to 20 as
   * content.multiImage, each with its alt text. The link of a post stays in its text: an article
   * post needs title and thumbnail set by the caller, because the Posts API does not scrape URLs.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
   * (checked 2026-11-25)
   */
  async publish(request: PublishRequest, ctx: AdapterContext): Promise<PublishResult> {
    if (ctx.dryRun) {
      throw new Error('A dry run must not reach publish.');
    }
    const author = this.authorOf(ctx);
    if (this.validatePost(request).length > 0) {
      throw new PlatformError('VALIDATION_REJECTED', 'The post does not meet the LinkedIn rules');
    }
    for (const media of request.media) {
      this.checkImage(media);
    }
    const scope = await this.scopeOf(ctx);

    const images: { id: string; altText: string | null }[] = [];
    for (const media of request.media) {
      await ctx.keepAlive();
      images.push({ id: await this.uploadImage(media, author, scope, ctx), altText: media.altText });
    }

    await ctx.keepAlive();
    const response = await this.api.createPost(this.postBody(author, request.text, images), scope);
    const postUrn = response.headers.get('x-restli-id') ?? '';
    if (!POST_URN.test(postUrn)) {
      throw new PlatformError('OUTCOME_UNKNOWN', 'linkedin.posts.create answered without a post id', {
        status: response.status,
      });
    }
    const meta: Record<string, unknown> = { images: images.map((image) => image.id) };
    const firstComment = request.firstComment?.trim() ?? '';
    if (firstComment.length > 0) {
      meta.firstComment = await this.commentOnce(postUrn, author, firstComment, scope, ctx);
    }
    return {
      externalPostId: postUrn,
      externalUrl: postUrlOf(postUrn),
      publishedAt: this.deps.clock.now(),
      meta,
    };
  }

  /**
   * A personal profile cannot read its own posts without r_member_social, a closed permission, so
   * the reconcile finds nothing and the publish job asks the user (NEEDS_ATTENTION, guide step
   * 4.12). A page reads its latest posts (r_organization_social) and compares the text.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
   * (checked 2026-11-25)
   */
  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    const author = this.authorOf(ctx);
    if (author.kind === 'person') {
      ctx.logger.info({ platform: 'LINKEDIN' }, 'linkedin.reconcile.not_possible_for_profiles');
      return null;
    }
    const posts = await this.api.postsByAuthor(author.urn, RECONCILE_POSTS, await this.scopeOf(ctx));
    const text = query.text.normalize('NFC').trim();
    const post = posts.find(
      (candidate) =>
        POST_URN.test(candidate.id) &&
        (candidate.lifecycleState ?? 'PUBLISHED') === 'PUBLISHED' &&
        (candidate.createdAt ?? 0) >= query.since.getTime() &&
        fromLittleText(candidate.commentary ?? '').trim() === text,
    );
    if (!post) {
      return null;
    }
    return {
      externalPostId: post.id,
      externalUrl: postUrlOf(post.id),
      publishedAt: new Date(post.publishedAt ?? post.createdAt ?? this.deps.clock.now().getTime()),
    };
  }

  /**
   * DELETE /rest/posts/{urn}; deleting an already deleted post answers 204 too. A 404 (unknown
   * post) also leaves the post absent, so it counts as done.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * (checked 2026-11-25)
   */
  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    if (!POST_URN.test(ref.externalPostId)) {
      throw new PlatformError('VALIDATION_REJECTED', 'The post id is not a LinkedIn post URN');
    }
    try {
      await this.api.deletePost(ref.externalPostId, await this.scopeOf(ctx));
    } catch (error) {
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
    const author = this.authorOf(ctx);
    if (author.kind === 'organization') {
      return this.organizationPostMetrics(author.urn, refs, ctx);
    }
    if (!this.config.features.memberPostAnalytics) {
      // No permission for personal post analytics: nothing is asked, nothing is invented.
      return refs.map((ref) =>
        this.metricsOf(ref.externalPostId, {
          linkedin: { source: 'none', reason: 'MEMBER_POST_ANALYTICS_NOT_ENABLED' },
        }),
      );
    }
    return this.memberPostMetrics(refs, ctx);
  }

  /** Lifetime numbers: the follower count of the page or, with its permission, of the member. */
  async fetchAccountMetrics(_range: DateRange, ctx: AdapterContext): Promise<AccountMetricsResult> {
    const author = this.authorOf(ctx);
    let raw: LinkedInAccountMetricsRaw;
    if (author.kind === 'organization') {
      const { firstDegreeSize } = await this.api.organizationFollowers(author.urn, await this.scopeOf(ctx));
      raw = { linkedin: { source: 'networkSizes', firstDegreeSize } };
    } else if (this.config.features.memberFollowerStatistics) {
      const data = await this.api.memberFollowers(await this.scopeOf(ctx));
      const element = data.elements[0];
      raw = element
        ? { linkedin: { source: 'memberFollowersCount', memberFollowersCount: element.memberFollowersCount } }
        : { linkedin: { source: 'none', reason: 'MEMBER_FOLLOWER_STATISTICS_NOT_ENABLED' } };
    } else {
      raw = { linkedin: { source: 'none', reason: 'MEMBER_FOLLOWER_STATISTICS_NOT_ENABLED' } };
    }
    return { ...normalizeLinkedInAccountMetrics(raw), raw, mappingVersion: MAP_VERSION };
  }

  /**
   * Personal posts: one memberCreatorPostAnalytics call per metric and post (five per post). The
   * docs do not say how a deleted post answers; a 404 ("entity that does not exist") is taken as
   * deleted. A failure after some posts returns those, the rest is asked for again later.
   */
  private async memberPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const scope = await this.scopeOf(ctx);
    const results: PostMetricsResult[] = [];
    for (const ref of refs) {
      try {
        const counts = {} as Record<MemberPostMetric, number | null>;
        for (const metric of MEMBER_POST_METRICS) {
          const data = await this.api.memberPostAnalytics(ref.externalPostId, metric, scope);
          counts[metric] =
            data.elements.length === 0
              ? null
              : data.elements.reduce((sum, element) => sum + element.count, 0);
        }
        results.push(
          this.metricsOf(ref.externalPostId, { linkedin: { source: 'memberCreatorPostAnalytics', counts } }),
        );
      } catch (error) {
        if (isPlatformError(error) && error.status === 404) {
          results.push({ kind: 'deleted', externalPostId: ref.externalPostId });
          continue;
        }
        if (results.length > 0) {
          ctx.logger.warn(
            { platform: 'LINKEDIN', code: isPlatformError(error) ? error.code : 'unknown' },
            'linkedin.metrics.partial',
          );
          break;
        }
        throw error;
      }
    }
    return results;
  }

  /**
   * Page posts: a BATCH_GET of the posts tells deleted ones apart (status 404), then the lifetime
   * share statistics of the rest. A post missing from the statistics has, by the docs, all counts
   * at 0.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics
   * (checked 2026-11-25)
   */
  private async organizationPostMetrics(
    organization: string,
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    const scope = await this.scopeOf(ctx);
    const urns = [...new Set(refs.map((ref) => ref.externalPostId).filter((urn) => POST_URN.test(urn)))];
    if (urns.length === 0) {
      return [];
    }
    const batch = await this.api.batchGetPosts(urns, scope);
    const deleted = new Set(
      urns.filter((urn) => batch.statuses[urn] === 404 || batch.errors[urn]?.status === 404),
    );
    const live = urns.filter((urn) => !deleted.has(urn) && batch.results[urn] !== undefined);

    const stats = new Map<string, LinkedInPostMetricsRaw>();
    for (const kind of ['shares', 'ugcPosts'] as const) {
      const prefix = kind === 'shares' ? 'urn:li:share:' : 'urn:li:ugcPost:';
      const ofKind = live.filter((urn) => urn.startsWith(prefix));
      if (ofKind.length === 0) {
        continue;
      }
      const elements = await this.api.shareStatistics(organization, kind, ofKind, scope);
      for (const urn of ofKind) {
        const element = elements.find((candidate) => (candidate.share ?? candidate.ugcPost) === urn);
        stats.set(urn, {
          linkedin: {
            source: 'organizationalEntityShareStatistics',
            totalShareStatistics: element?.totalShareStatistics ?? null,
          },
        });
      }
    }

    const results: PostMetricsResult[] = [];
    for (const ref of refs) {
      const raw = stats.get(ref.externalPostId);
      if (deleted.has(ref.externalPostId)) {
        results.push({ kind: 'deleted', externalPostId: ref.externalPostId });
      } else if (raw) {
        results.push(this.metricsOf(ref.externalPostId, raw));
      }
    }
    return results;
  }

  private metricsOf(externalPostId: string, raw: LinkedInPostMetricsRaw): PostMetricsResult {
    return {
      kind: 'metrics',
      externalPostId,
      metrics: normalizeLinkedInPostMetrics(raw),
      raw,
      mappingVersion: MAP_VERSION,
    };
  }

  /**
   * initializeUpload with the author as owner, PUT of the bytes; for a page owner, wait until the
   * image is AVAILABLE. A token with only w_member_social cannot read the image status through the
   * versioned API, so a personal image goes into the post right after the upload; the docs do not
   * say whether the Posts API waits for the processing itself.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
   * (checked 2026-11-25)
   */
  private async uploadImage(
    media: PublishMedia,
    author: Author,
    scope: CallScope,
    ctx: AdapterContext,
  ): Promise<string> {
    const bytes = await downloadMedia(media, {
      fetch: this.deps.mediaFetch ?? globalThis.fetch.bind(globalThis),
      maxBytes: this.deps.maxImageBytes ?? 20 * 1024 * 1024,
      timeoutMs: 60_000,
      signal: ctx.signal,
    });
    const { uploadUrl, image } = await this.api.initializeImageUpload(author.urn, scope);
    await this.api.uploadImage(uploadUrl, bytes, media.mimeType.toLowerCase(), scope);
    if (author.kind === 'organization') {
      await this.waitUntilAvailable(image, scope, ctx);
    }
    return image;
  }

  private async waitUntilAvailable(image: string, scope: CallScope, ctx: AdapterContext): Promise<void> {
    const wait = this.deps.wait ?? ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }));
    for (const delay of IMAGE_POLL_DELAYS_MS) {
      await wait(delay, ctx.signal);
      await ctx.keepAlive();
      const status = await this.api.imageStatus(image, scope);
      if (status === 'AVAILABLE') {
        return;
      }
      if (status === 'PROCESSING_FAILED') {
        throw new PlatformError('VALIDATION_REJECTED', 'LinkedIn could not process the image');
      }
    }
    throw new PlatformError('MEDIA_PROCESSING', 'LinkedIn is still processing the image');
  }

  /** The first comment goes out after the post; its failure does not undo the published post. */
  private async commentOnce(
    postUrn: string,
    author: Author,
    text: string,
    scope: CallScope,
    ctx: AdapterContext,
  ): Promise<'created' | 'failed'> {
    try {
      // Not settled by the docs: whether message.text of a comment uses the little Text Format of
      // the post commentary. It is sent as written.
      await this.api.createComment(postUrn, author.urn, text, scope);
      return 'created';
    } catch (error) {
      ctx.logger.warn(
        { platform: 'LINKEDIN', code: isPlatformError(error) ? error.code : 'unknown' },
        'linkedin.first_comment.failed',
      );
      return 'failed';
    }
  }

  private postBody(author: Author, text: string, images: readonly { id: string; altText: string | null }[]) {
    const withAlt = (image: { id: string; altText: string | null }) => {
      const altText = truncate(image.altText?.trim() ?? '', MAX_ALT_TEXT);
      return altText.length > 0 ? { id: image.id, altText } : { id: image.id };
    };
    const [first] = images;
    const content =
      images.length > 1
        ? { content: { multiImage: { images: images.map(withAlt) } } }
        : first
          ? { content: { media: withAlt(first) } }
          : {};
    return {
      author: author.urn,
      commentary: toLittleText(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      ...content,
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
  }

  private checkImage(media: PublishMedia): void {
    if (!IMAGE_MIME_TYPES.has(media.mimeType.toLowerCase())) {
      throw new PlatformError('VALIDATION_REJECTED', 'LinkedIn takes JPG, PNG and GIF images only');
    }
    if (media.width * media.height >= MAX_IMAGE_PIXELS) {
      throw new PlatformError('VALIDATION_REJECTED', 'The image has more pixels than LinkedIn takes');
    }
  }

  /** The author URN of the account: the person, or a page with the organizations feature. */
  private authorOf(ctx: AdapterContext): Author {
    const urn = ctx.account.externalId;
    if (PERSON_URN.test(urn)) {
      return { urn, kind: 'person' };
    }
    if (ORGANIZATION_URN.test(urn)) {
      if (!this.config.features.organizations) {
        throw new PlatformError(
          'PERMISSION_DENIED',
          'LinkedIn pages need the Community Management API, which this app is not set up for',
        );
      }
      return { urn, kind: 'organization' };
    }
    throw new PlatformError('VALIDATION_REJECTED', 'The account is not a LinkedIn person or organization');
  }

  private async scopeOf(ctx: AdapterContext): Promise<CallScope> {
    return { token: await ctx.credentials.accessToken(), accountId: ctx.account.id, signal: ctx.signal };
  }
}
