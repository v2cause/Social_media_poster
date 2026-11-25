import { z } from 'zod';

// The answers of LinkedIn the adapter reads, checked before use (guide B.1). The shapes follow the
// samples of the official documentation; fields the adapter does not use are dropped. Unknown enum
// values parse as strings, so a new status does not break a call that does not depend on it.

const count = z.number().int();

/**
 * The token answer of the code exchange and of a refresh. scope is documented as a space-delimited
 * list; the token introspection returns a comma-separated one, so both separators are accepted.
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
 * (checked 2026-11-25)
 */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * The OAuth error answer, for example invalid_request. Only the error value is used.
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 * (checked 2026-11-25)
 */
export const oauthErrorSchema = z.object({ error: z.string() });

/**
 * GET /v2/userinfo. email and email_verified are optional; locale is a string in the sample, but
 * is not used, so any shape passes.
 * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
 * (checked 2026-11-25)
 */
export const userinfoSchema = z.object({
  sub: z.string().min(1),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.string().optional(),
});
export type Userinfo = z.infer<typeof userinfoSchema>;

/**
 * The error body of the REST APIs: message, serviceErrorCode, status.
 * https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling
 * (checked 2026-11-25)
 */
export const restErrorSchema = z.object({
  message: z.string().optional(),
  serviceErrorCode: z.number().int().optional(),
  code: z.string().optional(),
});

export const IMAGE_URN = /^urn:li:image:[A-Za-z0-9_-]+$/;
/**
 * The id of a created post: urn:li:share:{id} or urn:li:ugcPost:{id}.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * (checked 2026-11-25)
 */
export const POST_URN = /^urn:li:(share|ugcPost):\d+$/;

/**
 * POST /rest/images?action=initializeUpload.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * (checked 2026-11-25)
 */
export const initializeUploadSchema = z.object({
  value: z.object({
    uploadUrl: z.url({ protocol: /^https$/ }),
    image: z.string().regex(IMAGE_URN),
    uploadUrlExpiresAt: z.number().int().optional(),
  }),
});

/**
 * GET /rest/images/{urn}: status is PROCESSING, PROCESSING_FAILED, AVAILABLE or WAITING_UPLOAD.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * (checked 2026-11-25)
 */
export const imageSchema = z.object({ status: z.string() });

const postSchema = z.object({
  id: z.string(),
  author: z.string().optional(),
  commentary: z.string().optional(),
  lifecycleState: z.string().optional(),
  createdAt: z.number().int().optional(),
  publishedAt: z.number().int().optional(),
});
export type LinkedInPost = z.infer<typeof postSchema>;

/**
 * GET /rest/posts?q=author (FINDER).
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * (checked 2026-11-25)
 */
export const postsByAuthorSchema = z.object({ elements: z.array(postSchema) });

/**
 * GET /rest/posts?ids=List(...) (BATCH_GET): results, statuses and errors keyed by URN. The shape
 * of an entry of errors is not documented (the samples show {}); only its status is read.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * (checked 2026-11-25)
 */
export const batchPostsSchema = z.object({
  results: z.record(z.string(), z.object({ lifecycleState: z.string().optional() })).default({}),
  statuses: z.record(z.string(), z.number().int()).default({}),
  errors: z.record(z.string(), z.object({ status: z.number().int().optional() })).default({}),
});

/**
 * GET /rest/memberCreatorPostAnalytics?q=entity. metricType is a string in the current version and
 * a union object ({"com.linkedin...CreatorPostAnalyticsMetricTypeV1": "REACTION"}) in older ones.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics
 * (checked 2026-11-25)
 */
export const memberPostAnalyticsSchema = z.object({
  elements: z.array(
    z.object({
      count,
      metricType: z.union([z.string(), z.record(z.string(), z.string())]),
    }),
  ),
});

/**
 * GET /rest/memberFollowersCount?q=me.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/follower-statistics
 * (checked 2026-11-25)
 */
export const memberFollowersSchema = z.object({
  elements: z.array(z.object({ memberFollowersCount: count })),
});

/**
 * GET /rest/organizationAcls?q=roleAssignee. The samples name the page "organization" in one place
 * and "organizationTarget" in another, so both are read.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
 * (checked 2026-11-25)
 */
export const organizationAclsSchema = z.object({
  elements: z.array(
    z.object({
      role: z.string(),
      state: z.string().optional(),
      organization: z.string().optional(),
      organizationTarget: z.string().optional(),
    }),
  ),
});

/**
 * GET /rest/organizations?ids=List(...) (BATCH_GET by numeric id).
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
 * (checked 2026-11-25)
 */
export const organizationsSchema = z.object({
  results: z
    .record(z.string(), z.object({ localizedName: z.string().optional(), vanityName: z.string().optional() }))
    .default({}),
});

/**
 * Lifetime statistics of single posts of a page. likeCount can become negative (an unlike of a
 * sponsored like counts as organic); uniqueImpressionsCount is missing in the sample for single
 * posts.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics
 * (checked 2026-11-25)
 */
export const shareStatisticsDataSchema = z.object({
  impressionCount: count.optional(),
  uniqueImpressionsCount: count.optional(),
  clickCount: count.optional(),
  likeCount: count.optional(),
  commentCount: count.optional(),
  shareCount: count.optional(),
});
export type ShareStatisticsData = z.infer<typeof shareStatisticsDataSchema>;

export const shareStatisticsSchema = z.object({
  elements: z.array(
    z.object({
      share: z.string().optional(),
      ugcPost: z.string().optional(),
      totalShareStatistics: shareStatisticsDataSchema,
    }),
  ),
});

/**
 * GET /rest/networkSizes/{organization URN}?edgeType=COMPANY_FOLLOWED_BY_MEMBER.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-lookup-api
 * (checked 2026-11-25)
 */
export const networkSizeSchema = z.object({ firstDegreeSize: count.nonnegative() });
