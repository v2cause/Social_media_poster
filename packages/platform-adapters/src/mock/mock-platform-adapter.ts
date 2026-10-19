import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  PlatformError,
  type AccountMetricsResult,
  type AdapterContext,
  type Clock,
  type ExternalPostRef,
  type NormalizedPostMetrics,
  type PostMetricsResult,
  type PublishRequest,
  type PublishResult,
  type RefreshOutcome,
  type SocialPlatformAdapter,
} from '@smp/core';
import {
  capabilitiesOf,
  validatePost,
  type Platform,
  type PlatformCapabilities,
  type ValidationIssue,
} from '@smp/platform-rules';
import { z } from 'zod';

import { platformErrorOf } from '../http/errors';
import { MAP_VERSION, normalizeMockAccountMetrics, normalizeMockPostMetrics } from './metrics-map';
import { MockOAuthConnector } from './mock-oauth-connector';
import type { MockPlatformStore, MockPost } from './mock-platform-store';

// The mock platforms of development and tests (guide step 4.4, architecture 16): the real
// capability tables, a fake OAuth page, latency, deterministic growing metrics and failures per
// account from SocialAccount.settings:
// - failMode: rate_limit_once (429 once per variant), auth_expired, unknown_outcome (nothing went
//   out, the answer is lost), permanent (refused), slow (the post goes out, the answer comes late:
//   a worker stopped meanwhile finds it again by reconcile);
// - failStatus: an HTTP status, mapped like a real answer, for the contract suite;
// - failUntil: the failures end at this time, like an outage of the platform (the drills of the
//   runbooks, guide step 8.7).

export const MOCK_FAIL_MODES = [
  'rate_limit_once',
  'auth_expired',
  'unknown_outcome',
  'permanent',
  'slow',
] as const;
export type MockFailMode = (typeof MOCK_FAIL_MODES)[number];

export const mockAccountSettingsSchema = z.object({
  latencyMs: z.number().int().min(0).max(120_000).optional(),
  failMode: z.enum(MOCK_FAIL_MODES).optional(),
  failStatus: z.number().int().min(400).max(599).optional(),
  retryAfterSeconds: z.number().int().min(0).max(3_600).optional(),
  failUntil: z.iso.datetime().optional(),
});
export type MockAccountSettings = z.infer<typeof mockAccountSettingsSchema>;

const SLOW_MS = 10_000;
/** Reads cost money on X, so its reconcile looks at the latest posts only (guide step 4.14). */
const X_RECONCILE_POSTS = 5;

/** Settings that do not parse count as none: a typo must not break publishing in development. */
const settingsOf = (ctx: AdapterContext, now: Date): MockAccountSettings => {
  const parsed = mockAccountSettingsSchema.safeParse(ctx.account.settings);
  if (!parsed.success) {
    return {};
  }
  const settings = parsed.data;
  // After failUntil the platform answers again, only its latency stays.
  if (settings.failUntil !== undefined && now.getTime() >= Date.parse(settings.failUntil)) {
    return settings.latencyMs === undefined ? {} : { latencyMs: settings.latencyMs };
  }
  return settings;
};

/** A small stable number per id, so metrics differ between posts but not between calls. */
const seedOf = (id: string): number => {
  let seed = 7;
  for (let index = 0; index < id.length; index += 1) {
    seed = (seed * 31 + id.charCodeAt(index)) % 997;
  }
  return seed;
};

export class MockPlatformAdapter implements SocialPlatformAdapter {
  readonly method = 'MOCK' as const;
  readonly connector: MockOAuthConnector;

  constructor(
    readonly platform: Platform,
    private readonly options: {
      store: MockPlatformStore;
      clock: Clock;
      /**
       * The fake OAuth page of the API, for example http://localhost:3000/api/dev/mock-oauth/authorize.
       * Only the API needs it; the workers never start an authorization.
       */
      authorizeUrl?: string;
      /** The latency of every call without a setting of its own. */
      defaultLatencyMs?: number;
    },
  ) {
    this.connector = new MockOAuthConnector(platform, options);
  }

  capabilities(): PlatformCapabilities {
    return capabilitiesOf(this.platform);
  }

  /**
   * Like the real platforms: Instagram renews its long-lived token and X renews with its refresh
   * token; LinkedIn and Facebook offer no refresh, so the account is connected again in time.
   */
  async refreshCredentials(ctx: AdapterContext): Promise<RefreshOutcome> {
    await this.call('refresh', ctx);
    if (settingsOf(ctx, this.options.clock.now()).failMode === 'auth_expired') {
      throw new PlatformError('AUTH_EXPIRED', 'The mock platform refused the refresh', { status: 401 });
    }
    if (this.platform !== 'INSTAGRAM' && (await ctx.credentials.refreshToken()) === null) {
      return { status: 'not_supported' };
    }
    return {
      status: 'refreshed',
      tokens: this.connector.tokens(this.options.clock.now().getTime(), this.connector.scopes),
    };
  }

  validatePost(request: PublishRequest): ValidationIssue[] {
    return validatePost({
      platform: this.platform,
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
    await this.call('publish', ctx);
    const settings = settingsOf(ctx, this.options.clock.now());
    switch (settings.failMode) {
      case 'auth_expired':
        throw new PlatformError('AUTH_EXPIRED', 'The mock platform refused the token', { status: 401 });
      case 'permanent':
        throw new PlatformError('VALIDATION_REJECTED', 'The mock platform refused the post', { status: 422 });
      case 'unknown_outcome':
        throw new PlatformError('OUTCOME_UNKNOWN', 'The answer of the mock platform got lost');
      case 'rate_limit_once':
        if (await this.options.store.setOnce(`rate-limit:${ctx.account.id}:${request.variantId}`)) {
          throw new PlatformError('RATE_LIMITED', 'The mock platform asks to wait', {
            status: 429,
            retryAfterMs: (settings.retryAfterSeconds ?? 2) * 1000,
          });
        }
        break;
      default:
        break;
    }
    this.failWithStatus(settings, 'mock.publish');
    if (this.validatePost(request).length > 0) {
      throw new PlatformError('VALIDATION_REJECTED', 'The mock platform refused the post', { status: 422 });
    }
    const post: MockPost = {
      // Random, so ids stay unique when a restarted process starts with an empty store.
      externalPostId: `mock-${this.platform.toLowerCase()}-${randomBytes(8).toString('hex')}`,
      accountId: ctx.account.id,
      text: request.text,
      contentHash: request.contentHash,
      publishedAt: this.options.clock.now(),
      deletedAt: null,
    };
    await this.options.store.save(post);
    await this.options.store.countCall('created', ctx.account.id);
    // X charges per post, a post with a link more (architecture "Faktenlage").
    if (this.platform === 'X') {
      await ctx.costs.record({
        operation: request.linkUrl === null ? 'x.post_create' : 'x.post_create_with_url',
      });
    }
    if (settings.failMode === 'slow') {
      await sleep(SLOW_MS, undefined, { signal: ctx.signal });
    }
    return this.resultOf(post);
  }

  async reconcile(
    query: { text: string; since: Date; contentHash: string },
    ctx: AdapterContext,
  ): Promise<PublishResult | null> {
    await this.call('reconcile', ctx);
    let posts = await this.options.store.postsOf(ctx.account.id);
    if (this.platform === 'X') {
      posts = posts
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
        .slice(0, X_RECONCILE_POSTS);
      if (posts.length > 0) {
        await ctx.costs.record({ operation: 'x.post_read', units: posts.length });
      }
    }
    const post = posts.find(
      (candidate) =>
        candidate.deletedAt === null &&
        candidate.contentHash === query.contentHash &&
        candidate.publishedAt >= query.since,
    );
    return post ? this.resultOf(post) : null;
  }

  async deletePost(ref: ExternalPostRef, ctx: AdapterContext): Promise<void> {
    await this.call('delete', ctx);
    const post = await this.ownPost(ref.externalPostId, ctx);
    await this.options.store.save({ ...post, deletedAt: this.options.clock.now() });
  }

  /**
   * One call for all posts, like the batch reads of the real platforms. A post the platform does
   * not know, or that was deleted, comes back as deleted; on X every post read costs, as with
   * the real API.
   */
  async fetchPostMetrics(
    refs: readonly ExternalPostRef[],
    ctx: AdapterContext,
  ): Promise<PostMetricsResult[]> {
    await this.call('metrics', ctx);
    const results = await Promise.all(
      refs.map(async (ref): Promise<PostMetricsResult> => {
        const post = await this.options.store.find(ref.externalPostId);
        if (!post || post.accountId !== ctx.account.id || post.deletedAt !== null) {
          return { kind: 'deleted', externalPostId: ref.externalPostId };
        }
        const raw = { mock: this.countersOf(post) };
        return {
          kind: 'metrics',
          externalPostId: post.externalPostId,
          metrics: normalizeMockPostMetrics(raw),
          raw,
          mappingVersion: MAP_VERSION,
        };
      }),
    );
    const read = results.filter((result) => result.kind === 'metrics').length;
    if (this.platform === 'X' && read > 0) {
      await ctx.costs.record({ operation: 'x.post_read', units: read });
    }
    return results;
  }

  async fetchAccountMetrics(
    _range: { from: Date; to: Date },
    ctx: AdapterContext,
  ): Promise<AccountMetricsResult> {
    await this.call('account-metrics', ctx);
    const posts = (await this.options.store.postsOf(ctx.account.id)).length;
    const followers = 500 + seedOf(ctx.account.id) + posts * 3;
    const raw = {
      mock: { followers, reach: followers * 4, profileViews: Math.round(followers / 5) },
    };
    return { ...normalizeMockAccountMetrics(raw), raw, mappingVersion: MAP_VERSION };
  }

  /** Counts the call, waits the latency and fails with failStatus where one is set. */
  private async call(operation: string, ctx: AdapterContext): Promise<void> {
    await this.options.store.countCall(operation, ctx.account.id);
    const latency = settingsOf(ctx, this.options.clock.now()).latencyMs ?? this.options.defaultLatencyMs ?? 0;
    if (latency > 0) {
      await sleep(latency, undefined, { signal: ctx.signal });
    }
    if (operation !== 'publish') {
      this.failWithStatus(settingsOf(ctx, this.options.clock.now()), `mock.${operation}`);
    }
  }

  private failWithStatus(settings: MockAccountSettings, operation: string): void {
    if (settings.failStatus === undefined) {
      return;
    }
    const headers = new Headers();
    if (settings.retryAfterSeconds !== undefined) {
      headers.set('retry-after', String(settings.retryAfterSeconds));
    }
    throw platformErrorOf(
      { status: settings.failStatus, headers },
      operation,
      this.options.clock.now().getTime(),
    );
  }

  private async ownPost(externalPostId: string, ctx: AdapterContext): Promise<MockPost> {
    const post = await this.options.store.find(externalPostId);
    if (!post || post.accountId !== ctx.account.id) {
      throw new PlatformError('VALIDATION_REJECTED', 'The mock platform does not know the post', {
        status: 404,
      });
    }
    return post;
  }

  private resultOf(post: MockPost): PublishResult {
    return {
      externalPostId: post.externalPostId,
      externalUrl: `https://mock.${this.platform.toLowerCase()}.example/posts/${post.externalPostId}`,
      publishedAt: post.publishedAt,
    };
  }

  /** Grows quickly in the first day and slowly after, the same for every call at the same time. */
  private countersOf(post: MockPost): NormalizedPostMetrics {
    const hours = Math.max(0, (this.options.clock.now().getTime() - post.publishedAt.getTime()) / 3_600_000);
    const impressions = Math.round(
      (200 + seedOf(post.externalPostId)) * (1 - Math.exp(-hours / 12)) * (1 + hours / 240),
    );
    const share = (rate: number): number => Math.round(impressions * rate);
    return {
      impressions,
      reach: this.platform === 'X' ? null : share(0.8),
      likes: share(0.05),
      comments: share(0.01),
      shares: share(0.005),
      clicks: this.platform === 'INSTAGRAM' ? null : share(0.02),
      saves: this.platform === 'INSTAGRAM' ? share(0.01) : null,
      views: null,
    };
  }
}
