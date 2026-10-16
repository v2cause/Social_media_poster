import type { Platform } from '@smp/platform-rules';

// The fixed URLs of the OAuth flow (guide steps 4.4 and 4.5). The callback is global, so one
// redirect URI per platform can be registered with the platform app.

/** The platform in the path of the callback, for example /api/oauth/linkedin/callback. */
export const platformSlugOf = (platform: Platform): string => platform.toLowerCase();

export const oauthCallbackUrl = (appUrl: string, platform: Platform): string =>
  new URL(`/api/oauth/${platformSlugOf(platform)}/callback`, appUrl).toString();

/** The fake OAuth page of the mock platforms; it exists outside production only. */
export const mockAuthorizeUrl = (appUrl: string): string =>
  new URL('/api/dev/mock-oauth/authorize', appUrl).toString();
