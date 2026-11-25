import { z } from 'zod';

// The settings of the LinkedIn adapter (guide step 4.12, architecture 4.2). Facts checked against
// the official documentation on 2026-11-25; each one names its page.

/**
 * OAuth 2.0 endpoints of the authorization code flow.
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 * (checked 2026-11-25)
 */
export const LINKEDIN_AUTHORIZATION_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

/**
 * The userinfo endpoint of "Sign In with LinkedIn using OpenID Connect".
 * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
 * (checked 2026-11-25)
 */
export const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

/**
 * The base path of the versioned APIs (Posts, Images, analytics, organizations).
 * https://learn.microsoft.com/en-us/linkedin/marketing/versioning (checked 2026-11-25)
 */
export const LINKEDIN_REST_URL = 'https://api.linkedin.com/rest';

/**
 * The latest version on 2026-11-25 ("November 2026", header value 202611). Versions are released
 * monthly and supported for at least one year; there is no default version, every call names one.
 * https://learn.microsoft.com/en-us/linkedin/marketing/versioning (checked 2026-11-25)
 */
export const LINKEDIN_DEFAULT_VERSION = '202611';

/**
 * Self-serve scopes: "Sign In with LinkedIn using OpenID Connect" grants openid, profile and email;
 * "Share on LinkedIn" grants w_member_social. Both products are open to every developer app.
 * email is not requested: the adapter does not need the address.
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access
 * https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
 * (checked 2026-11-25)
 */
export const LINKEDIN_PROFILE_SCOPES = ['openid', 'profile', 'w_member_social'] as const;

/**
 * Impressions, reach, reactions, comments and reshares of the member's own posts
 * (memberCreatorPostAnalytics). Part of the Community Management API, which needs LinkedIn's
 * approval.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview
 * (checked 2026-11-25)
 */
export const LINKEDIN_MEMBER_POST_ANALYTICS_SCOPES = ['r_member_postAnalytics'] as const;

/**
 * The member's follower count (memberFollowersCount), also from the Community Management API.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/follower-statistics
 * (checked 2026-11-25)
 */
export const LINKEDIN_MEMBER_FOLLOWER_SCOPES = ['r_member_profileAnalytics'] as const;

/**
 * Company pages: posting (w_organization_social), reading the page's posts for reconcile and
 * metrics (r_organization_social), listing administered pages, their names, share statistics and
 * follower counts (rw_organization_admin). Community Management API, approval required.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics
 * (checked 2026-11-25)
 */
export const LINKEDIN_ORGANIZATION_SCOPES = [
  'w_organization_social',
  'r_organization_social',
  'rw_organization_admin',
] as const;

/** What the LinkedIn app was approved for beyond the self-serve products. */
export const linkedInFeaturesSchema = z.object({
  /** r_member_postAnalytics: post metrics of the personal profile. */
  memberPostAnalytics: z.boolean().default(false),
  /** r_member_profileAnalytics: the follower count of the personal profile. */
  memberFollowerStatistics: z.boolean().default(false),
  /** Company pages through the Community Management API. */
  organizations: z.boolean().default(false),
});
export type LinkedInFeatures = z.infer<typeof linkedInFeaturesSchema>;

export const NO_LINKEDIN_FEATURES: LinkedInFeatures = {
  memberPostAnalytics: false,
  memberFollowerStatistics: false,
  organizations: false,
};

/**
 * The scopes to ask for: only those the app can grant, because LinkedIn refuses the whole
 * authorization when one scope is not assigned to the app ("Invalid scope", HTTP 401), and a token
 * with other scopes than the previous one invalidates the earlier tokens.
 * https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 * (checked 2026-11-25)
 */
export function linkedInScopes(features: Partial<LinkedInFeatures> = {}): string[] {
  return [
    ...LINKEDIN_PROFILE_SCOPES,
    ...(features.memberPostAnalytics === true ? LINKEDIN_MEMBER_POST_ANALYTICS_SCOPES : []),
    ...(features.memberFollowerStatistics === true ? LINKEDIN_MEMBER_FOLLOWER_SCOPES : []),
    ...(features.organizations === true ? LINKEDIN_ORGANIZATION_SCOPES : []),
  ];
}

/** The app credentials and the pinned API version, checked when the adapter is built. */
export const linkedInAppConfigSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  /** Header value in the format YYYYMM. */
  version: z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, 'LinkedIn-Version is YYYYMM'),
  features: linkedInFeaturesSchema.default(NO_LINKEDIN_FEATURES),
});
export type LinkedInAppConfig = z.infer<typeof linkedInAppConfigSchema>;

// .env.example and Compose set empty strings for unset values.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);
const flag = z.preprocess(unsetIfEmpty, z.stringbool().default(false));

/**
 * The environment of a live LinkedIn adapter (PLATFORM_MODE_LINKEDIN=live). The wiring parses it
 * and passes the result to createLinkedInAdapter through linkedInConfigFromEnv.
 */
export const linkedInEnvSchema = z.object({
  LINKEDIN_CLIENT_ID: z.string().trim().min(1),
  LINKEDIN_CLIENT_SECRET: z.string().min(1),
  LINKEDIN_VERSION: z.preprocess(unsetIfEmpty, z.string().default(LINKEDIN_DEFAULT_VERSION)),
  LINKEDIN_MEMBER_POST_ANALYTICS: flag,
  LINKEDIN_MEMBER_FOLLOWER_STATISTICS: flag,
  LINKEDIN_ORGANIZATIONS: flag,
});
export type LinkedInEnv = z.infer<typeof linkedInEnvSchema>;

export function linkedInConfigFromEnv(env: LinkedInEnv): LinkedInAppConfig {
  return linkedInAppConfigSchema.parse({
    clientId: env.LINKEDIN_CLIENT_ID,
    clientSecret: env.LINKEDIN_CLIENT_SECRET,
    version: env.LINKEDIN_VERSION,
    features: {
      memberPostAnalytics: env.LINKEDIN_MEMBER_POST_ANALYTICS,
      memberFollowerStatistics: env.LINKEDIN_MEMBER_FOLLOWER_STATISTICS,
      organizations: env.LINKEDIN_ORGANIZATIONS,
    },
  });
}
