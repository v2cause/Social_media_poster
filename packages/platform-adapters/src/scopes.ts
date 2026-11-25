import type { Platform } from '@smp/platform-rules';

import { FACEBOOK_SCOPES, INSTAGRAM_SCOPES } from './meta/meta-scopes';

// The scopes each platform is asked for (architecture 4.2). The mock connector asks for the same,
// so the comparison of granted and requested scopes is exercised without a real platform. Facebook
// and Instagram take the lists of their real connectors; the real LinkedIn connector asks only for
// the scopes of the products its app has (linkedInScopes), the mock for all of them.

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
  FACEBOOK: FACEBOOK_SCOPES,
  INSTAGRAM: INSTAGRAM_SCOPES,
  X: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
};
