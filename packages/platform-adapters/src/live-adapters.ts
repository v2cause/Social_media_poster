import type { AdapterLogger, Clock, SocialPlatformAdapter } from '@smp/core';
import type { Platform } from '@smp/platform-rules';

import { PlatformConfigError } from './create-registry';
import type { PlatformEnv } from './env';
import { createLinkedInAdapter } from './linkedin';
import { createFacebookAdapter, createInstagramAdapter } from './meta';
import type { PlatformRateLimiter } from './rate-limit/platform-rate-limiter';
import { createXAdapter } from './x';

// The real adapters of the live platforms, built from the app credentials in the environment
// (guide steps 4.12 to 4.14). The registry calls a builder only for a platform whose mode is live;
// a builder without its credentials stops the start with the names of the missing variables, never
// their values.

export interface LiveAdapterOptions {
  clock: Clock;
  logger?: AdapterLogger;
  /** The shared limiter of the workers; without one the calls are not throttled. */
  limiter?: PlatformRateLimiter;
}

type Credentials = Pick<
  PlatformEnv,
  | 'LINKEDIN_CLIENT_ID'
  | 'LINKEDIN_CLIENT_SECRET'
  | 'LINKEDIN_VERSION'
  | 'LINKEDIN_MEMBER_POST_ANALYTICS'
  | 'LINKEDIN_MEMBER_FOLLOWER_STATISTICS'
  | 'LINKEDIN_ORGANIZATIONS'
  | 'META_APP_ID'
  | 'META_APP_SECRET'
  | 'META_GRAPH_VERSION'
  | 'META_FACEBOOK_LOGIN_CONFIG_ID'
  | 'META_INSTAGRAM_LOGIN_CONFIG_ID'
  | 'META_PUBLIC_MEDIA_BASE_URL'
  | 'X_CLIENT_ID'
  | 'X_CLIENT_SECRET'
  | 'X_APP_OWNER_USER_ID'
>;

function required<K extends keyof Credentials>(
  env: Credentials,
  platform: string,
  names: readonly K[],
): { [P in K]: string } {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new PlatformConfigError(
      `${platform} is live, but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
    );
  }
  return Object.fromEntries(names.map((name) => [name, String(env[name])])) as { [P in K]: string };
}

const optional = <T extends object>(values: T): Partial<T> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;

/** The builders of the real adapters, for createAdapterRegistry({ live }). */
export function liveAdapters(
  env: Credentials,
  options: LiveAdapterOptions,
): Partial<Record<Platform, () => SocialPlatformAdapter>> {
  const shared = optional({ logger: options.logger, limiter: options.limiter });
  const metaApp = () => {
    const app = required(env, 'Facebook and Instagram', ['META_APP_ID', 'META_APP_SECRET']);
    return {
      appId: app.META_APP_ID,
      appSecret: app.META_APP_SECRET,
      ...optional({ graphVersion: env.META_GRAPH_VERSION }),
    };
  };
  return {
    LINKEDIN: () => {
      const app = required(env, 'LinkedIn', ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']);
      return createLinkedInAdapter({
        clientId: app.LINKEDIN_CLIENT_ID,
        clientSecret: app.LINKEDIN_CLIENT_SECRET,
        ...optional({ version: env.LINKEDIN_VERSION }),
        features: {
          memberPostAnalytics: env.LINKEDIN_MEMBER_POST_ANALYTICS,
          memberFollowerStatistics: env.LINKEDIN_MEMBER_FOLLOWER_STATISTICS,
          organizations: env.LINKEDIN_ORGANIZATIONS,
        },
        clock: options.clock,
        ...shared,
      });
    },
    FACEBOOK: () =>
      createFacebookAdapter({
        app: metaApp(),
        clock: options.clock,
        ...optional({ loginConfigId: env.META_FACEBOOK_LOGIN_CONFIG_ID }),
        ...shared,
      }),
    INSTAGRAM: () =>
      createInstagramAdapter({
        app: metaApp(),
        clock: options.clock,
        ...optional({
          loginConfigId: env.META_INSTAGRAM_LOGIN_CONFIG_ID,
          publicMediaBaseUrl: env.META_PUBLIC_MEDIA_BASE_URL,
        }),
        ...shared,
      }),
    X: () => {
      const app = required(env, 'X', ['X_CLIENT_ID', 'X_CLIENT_SECRET']);
      return createXAdapter({
        clientId: app.X_CLIENT_ID,
        clientSecret: app.X_CLIENT_SECRET,
        clock: options.clock,
        ...optional({ ownerUserId: env.X_APP_OWNER_USER_ID }),
        ...shared,
      });
    },
  };
}
