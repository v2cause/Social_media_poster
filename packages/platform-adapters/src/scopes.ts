import type { Platform } from '@smp/platform-rules';

// The scopes each platform is asked for (architecture 4.2). The mock connector asks for the same,
// so the comparison of granted and requested scopes is exercised without a real platform.

export const PLATFORM_SCOPES: Readonly<Record<Platform, readonly string[]>> = {
  LINKEDIN: [
    'openid',
    'profile',
    'email',
    'w_member_social',
    'r_member_postAnalytics',
    'w_organization_social',
    'r_organization_social',
    'rw_organization_admin',
  ],
  FACEBOOK: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'read_insights'],
  INSTAGRAM: [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_insights',
  ],
  X: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
};
