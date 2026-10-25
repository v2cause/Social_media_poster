import type { SocialPlatformAdapter } from '@smp/core';
import type { Platform } from '@smp/platform-rules';

import type { PlatformEnv } from '../env';
import { LinkedInAdapter } from '../linkedin/linkedin-adapter';
import { FacebookAdapter } from '../meta/facebook-adapter';
import { InstagramAdapter } from '../meta/instagram-adapter';
import { XApiAdapter } from '../x/x-adapter';
import type { LiveAdapterDeps } from './live-support';

// The real adapters of the live platforms (guide steps 4.12 to 4.14), built from the app
// credentials of PLATFORM_MODE_* and the variables next to them. checkPlatformEnv has made sure a
// live platform has its credentials; Instagram is optional within Meta and stays out (null)
// without its own app.

export type LiveAdapterBuilders = Partial<Record<Platform, (() => SocialPlatformAdapter) | null>>;

const required = (value: string | undefined, name: string): string => {
  if (value === undefined) {
    throw new Error(`${name} is required for the live adapter.`);
  }
  return value;
};

export function liveAdapters(env: PlatformEnv, deps: LiveAdapterDeps): LiveAdapterBuilders {
  const builders: LiveAdapterBuilders = {};
  if (env.PLATFORM_MODE_LINKEDIN === 'live') {
    builders.LINKEDIN = () =>
      new LinkedInAdapter(
        {
          clientId: required(env.LINKEDIN_CLIENT_ID, 'LINKEDIN_CLIENT_ID'),
          clientSecret: required(env.LINKEDIN_CLIENT_SECRET, 'LINKEDIN_CLIENT_SECRET'),
          version: required(env.LINKEDIN_VERSION, 'LINKEDIN_VERSION'),
          organizations: env.LINKEDIN_ORGANIZATIONS,
          memberAnalytics: env.LINKEDIN_MEMBER_ANALYTICS,
        },
        deps,
      );
  }
  if (env.PLATFORM_MODE_META === 'live') {
    const graphVersion = required(env.META_GRAPH_VERSION, 'META_GRAPH_VERSION');
    builders.FACEBOOK = () =>
      new FacebookAdapter(
        {
          appId: required(env.META_APP_ID, 'META_APP_ID'),
          appSecret: required(env.META_APP_SECRET, 'META_APP_SECRET'),
          graphVersion,
          ...(env.META_LOGIN_CONFIG_ID ? { loginConfigId: env.META_LOGIN_CONFIG_ID } : {}),
        },
        deps,
      );
    const instagramAppId = env.INSTAGRAM_APP_ID;
    const instagramAppSecret = env.INSTAGRAM_APP_SECRET;
    builders.INSTAGRAM =
      instagramAppId && instagramAppSecret
        ? () =>
            new InstagramAdapter({ appId: instagramAppId, appSecret: instagramAppSecret, graphVersion }, deps)
        : null;
  }
  if (env.PLATFORM_MODE_X === 'live') {
    builders.X = () =>
      new XApiAdapter(
        {
          clientId: required(env.X_CLIENT_ID, 'X_CLIENT_ID'),
          ...(env.X_CLIENT_SECRET ? { clientSecret: env.X_CLIENT_SECRET } : {}),
        },
        deps,
      );
  }
  return builders;
}
