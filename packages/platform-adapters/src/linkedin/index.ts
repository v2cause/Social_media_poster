// The LinkedIn adapter (guide step 4.12): the factory, its settings and the pieces the wiring and
// the analytics need.

export {
  LINKEDIN_DEFAULT_VERSION,
  LINKEDIN_MEMBER_FOLLOWER_SCOPES,
  LINKEDIN_MEMBER_POST_ANALYTICS_SCOPES,
  LINKEDIN_ORGANIZATION_SCOPES,
  LINKEDIN_PROFILE_SCOPES,
  linkedInAppConfigSchema,
  linkedInConfigFromEnv,
  linkedInEnvSchema,
  linkedInFeaturesSchema,
  linkedInScopes,
  type LinkedInAppConfig,
  type LinkedInEnv,
  type LinkedInFeatures,
} from './config';
export { createLinkedInAdapter, type LinkedInAdapterOptions } from './create-linkedin-adapter';
export { LinkedInApiAdapter } from './linkedin-adapter';
export { LinkedInOAuthConnector } from './linkedin-oauth-connector';
export { escapeLittleText, fromLittleText, toLittleText } from './little-text';
export {
  MAP_VERSION as LINKEDIN_MAP_VERSION,
  MEMBER_POST_METRICS as LINKEDIN_MEMBER_POST_METRICS,
  normalizeLinkedInAccountMetrics,
  normalizeLinkedInPostMetrics,
} from './metrics-map';
