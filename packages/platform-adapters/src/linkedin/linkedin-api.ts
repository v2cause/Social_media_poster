import { PlatformError } from '@smp/core';
import type { z } from 'zod';

import type { PlatformHttpClient, PlatformRequest, PlatformResponse } from '../http/platform-http-client';
import { LINKEDIN_REST_URL } from './config';
import { mapRestError } from './errors';
import {
  batchPostsSchema,
  imageSchema,
  initializeUploadSchema,
  memberFollowersSchema,
  memberPostAnalyticsSchema,
  networkSizeSchema,
  organizationAclsSchema,
  organizationsSchema,
  postsByAuthorSchema,
  shareStatisticsSchema,
} from './schemas';

// The calls of the versioned REST APIs (https://api.linkedin.com/rest). Every call sends
// "LinkedIn-Version: YYYYMM" and "X-Restli-Protocol-Version: 2.0.0"; a missing version header is
// refused.
// https://learn.microsoft.com/en-us/linkedin/marketing/versioning
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
// (checked 2026-11-25)
//
// Rest.li 2.0 encodes a URN inside a path or a List(...) with percent escapes (urn%3Ali%3Ashare%3A1)
// and keeps "List(", "," and ")" as they are, like the samples of the documentation.

/** Who a call is for: the token, and the account its rate-limit bucket belongs to. */
export interface CallScope {
  token: string;
  accountId?: string;
  signal?: AbortSignal;
}

const encodeUrn = (urn: string): string => encodeURIComponent(urn);
const listOf = (values: readonly string[]): string => `List(${values.map(encodeUrn).join(',')})`;

/** The memberCreatorPostAnalytics entity: (share:urn...) or (ugc:urn...). */
const analyticsEntityOf = (postUrn: string): string =>
  `(${postUrn.startsWith('urn:li:ugcPost:') ? 'ugc' : 'share'}:${encodeUrn(postUrn)})`;

/**
 * Hosts LinkedIn hands out upload URLs on: www.linkedin.com/dms-uploads and
 * api.linkedin.com/mediaUpload in the samples. The token goes only to these.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api
 * (checked 2026-11-25)
 */
const isLinkedInHost = (host: string): boolean => host === 'linkedin.com' || host.endsWith('.linkedin.com');

export class LinkedInApi {
  constructor(
    private readonly http: PlatformHttpClient,
    private readonly version: string,
  ) {}

  /**
   * POST /rest/images?action=initializeUpload with the owner (person or organization URN).
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
   * (checked 2026-11-25)
   */
  async initializeImageUpload(
    owner: string,
    scope: CallScope,
  ): Promise<{ uploadUrl: string; image: string }> {
    const response = await this.rest(scope, {
      operation: 'linkedin.images.initialize_upload',
      method: 'POST',
      path: '/images?action=initializeUpload',
      body: { json: { initializeUploadRequest: { owner } } },
      schema: initializeUploadSchema,
      // Repeating it only registers another, unused upload.
      idempotent: true,
    });
    return response.data.value;
  }

  /**
   * PUT of the bytes to the upload URL, with the OAuth token in the Authorization header (unlike
   * the video upload). Answers 201 without a body.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/vector-asset-api
   * (checked 2026-11-25)
   */
  async uploadImage(
    uploadUrl: string,
    bytes: Uint8Array,
    contentType: string,
    scope: CallScope,
  ): Promise<void> {
    const url = new URL(uploadUrl);
    if (url.protocol !== 'https:' || !isLinkedInHost(url.hostname)) {
      throw new PlatformError('TRANSIENT', 'linkedin.images.upload got an upload URL outside of LinkedIn');
    }
    await this.http.request({
      operation: 'linkedin.images.upload',
      method: 'PUT',
      url: uploadUrl,
      headers: { authorization: `Bearer ${scope.token}` },
      body: { bytes, contentType },
      timeoutMs: 120_000,
      mapError: mapRestError('linkedin.images.upload'),
      ...this.extras(scope),
    });
  }

  /**
   * GET /rest/images/{urn}. A token with only w_member_social cannot read images through the
   * versioned API, so this runs for organization owners only.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
   * (checked 2026-11-25)
   */
  async imageStatus(imageUrn: string, scope: CallScope): Promise<string> {
    const response = await this.rest(scope, {
      operation: 'linkedin.images.get',
      method: 'GET',
      path: `/images/${encodeUrn(imageUrn)}`,
      schema: imageSchema,
    });
    return response.data.status;
  }

  /**
   * POST /rest/posts. The answer is 201 with the post id in the x-restli-id header.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * (checked 2026-11-25)
   */
  async createPost(body: unknown, scope: CallScope): Promise<PlatformResponse<undefined>> {
    return this.rest(scope, {
      operation: 'linkedin.posts.create',
      method: 'POST',
      path: '/posts',
      body: { json: body },
      idempotent: false,
      mapError: mapRestError('linkedin.posts.create', { create: true }),
    });
  }

  /**
   * DELETE /rest/posts/{urn} with X-RestLi-Method: DELETE; 204, also for an already deleted post.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * (checked 2026-11-25)
   */
  async deletePost(postUrn: string, scope: CallScope): Promise<void> {
    await this.rest(scope, {
      operation: 'linkedin.posts.delete',
      method: 'DELETE',
      path: `/posts/${encodeUrn(postUrn)}`,
      headers: { 'x-restli-method': 'DELETE' },
    });
  }

  /**
   * GET /rest/posts?author=...&q=author&sortBy=CREATED (FINDER, count up to 100). Needs
   * r_organization_social for a page, or r_member_social for a person, a closed permission.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * (checked 2026-11-25)
   */
  async postsByAuthor(author: string, count: number, scope: CallScope) {
    const response = await this.rest(scope, {
      operation: 'linkedin.posts.find_by_author',
      method: 'GET',
      path: `/posts?author=${encodeUrn(author)}&q=author&count=${String(count)}&sortBy=CREATED`,
      headers: { 'x-restli-method': 'FINDER' },
      schema: postsByAuthorSchema,
    });
    return response.data.elements;
  }

  /**
   * GET /rest/posts?ids=List(...) with X-RestLi-Method: BATCH_GET.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
   * (checked 2026-11-25)
   */
  async batchGetPosts(postUrns: readonly string[], scope: CallScope) {
    const response = await this.rest(scope, {
      operation: 'linkedin.posts.batch_get',
      method: 'GET',
      path: `/posts?ids=${listOf(postUrns)}`,
      headers: { 'x-restli-method': 'BATCH_GET' },
      schema: batchPostsSchema,
    });
    return response.data;
  }

  /**
   * POST /rest/socialActions/{post URN}/comments with actor, object and message.text.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
   * (checked 2026-11-25)
   */
  async createComment(postUrn: string, actor: string, text: string, scope: CallScope): Promise<void> {
    await this.rest(scope, {
      operation: 'linkedin.comments.create',
      method: 'POST',
      path: `/socialActions/${encodeUrn(postUrn)}/comments`,
      body: { json: { actor, object: postUrn, message: { text } } },
      idempotent: false,
    });
  }

  /**
   * GET /rest/memberCreatorPostAnalytics?q=entity&entity=(share:...)&queryType=... (lifetime total
   * without aggregation and dateRange). One metric per call; the docs show no batch for several
   * posts or metrics.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics
   * (checked 2026-11-25)
   */
  async memberPostAnalytics(postUrn: string, queryType: string, scope: CallScope) {
    const response = await this.rest(scope, {
      operation: 'linkedin.member_post_analytics',
      method: 'GET',
      path: `/memberCreatorPostAnalytics?q=entity&entity=${analyticsEntityOf(postUrn)}&queryType=${queryType}`,
      schema: memberPostAnalyticsSchema,
    });
    return response.data;
  }

  /**
   * GET /rest/memberFollowersCount?q=me (lifetime count).
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/follower-statistics
   * (checked 2026-11-25)
   */
  async memberFollowers(scope: CallScope) {
    const response = await this.rest(scope, {
      operation: 'linkedin.member_followers',
      method: 'GET',
      path: '/memberFollowersCount?q=me',
      schema: memberFollowersSchema,
    });
    return response.data;
  }

  /**
   * GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
   * (checked 2026-11-25)
   */
  async administeredOrganizations(scope: CallScope, start = 0, count = 100) {
    const response = await this.rest(scope, {
      operation: 'linkedin.organization_acls',
      method: 'GET',
      path: `/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&start=${String(start)}&count=${String(count)}`,
      schema: organizationAclsSchema,
    });
    return response.data.elements;
  }

  /**
   * GET /rest/organizations?ids=List(id1,id2) by numeric id; needs the ADMINISTRATOR role.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
   * (checked 2026-11-25)
   */
  async organizations(ids: readonly string[], scope: CallScope) {
    const response = await this.rest(scope, {
      operation: 'linkedin.organizations.batch_get',
      method: 'GET',
      path: `/organizations?ids=List(${ids.join(',')})`,
      schema: organizationsSchema,
    });
    return response.data.results;
  }

  /**
   * GET /rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=...
   * with shares=List(...) or ugcPosts=List(...): lifetime statistics of single posts. The docs show
   * ugcPosts only in the Rest.li 1.0 form (ugcPosts[0]=...); the List form is the Rest.li 2.0
   * equivalent of the documented shares=List(...) and is not shown for ugcPosts.
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics
   * (checked 2026-11-25)
   */
  async shareStatistics(
    organization: string,
    kind: 'shares' | 'ugcPosts',
    postUrns: readonly string[],
    scope: CallScope,
  ) {
    const response = await this.rest(scope, {
      operation: 'linkedin.share_statistics',
      method: 'GET',
      path: `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeUrn(organization)}&${kind}=${listOf(postUrns)}`,
      schema: shareStatisticsSchema,
    });
    return response.data.elements;
  }

  /**
   * GET /rest/networkSizes/{organization URN}?edgeType=COMPANY_FOLLOWED_BY_MEMBER (from 202305).
   * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
   * (checked 2026-11-25)
   */
  async organizationFollowers(organization: string, scope: CallScope) {
    const response = await this.rest(scope, {
      operation: 'linkedin.network_sizes',
      method: 'GET',
      path: `/networkSizes/${encodeUrn(organization)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
      schema: networkSizeSchema,
    });
    return response.data;
  }

  private rest<T>(
    scope: CallScope,
    request: Omit<PlatformRequest<T>, 'url'> & { path: string; schema?: z.ZodType<T> },
  ): Promise<PlatformResponse<T>> {
    const { path, headers, ...rest } = request;
    return this.http.request<T>({
      mapError: mapRestError(request.operation),
      ...rest,
      url: `${LINKEDIN_REST_URL}${path}`,
      headers: {
        authorization: `Bearer ${scope.token}`,
        'linkedin-version': this.version,
        'x-restli-protocol-version': '2.0.0',
        ...headers,
      },
      ...this.extras(scope),
    });
  }

  private extras(scope: CallScope): Pick<PlatformRequest<unknown>, 'signal' | 'rateLimit'> {
    return {
      ...(scope.signal ? { signal: scope.signal } : {}),
      ...(scope.accountId === undefined ? {} : { rateLimit: { accountId: scope.accountId } }),
    };
  }
}
