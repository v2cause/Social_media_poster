import type { Platform } from '@smp/platform-rules';
import { z } from 'zod';

// The platform settings of the API and the worker (.env.example, architecture 16). Facebook and
// Instagram share one Meta app, so they share one mode:
// - mock: the mock adapter with the fake OAuth page of the API. Outside production only; in
//   production a platform in mock mode is not offered.
// - live: the real adapter with the app credentials of the platform (guide steps 4.12 to 4.14).
// - off: the platform is not offered. The single-user mode (ADR 0046) uses it for platforms whose
//   app credentials are missing, so that nothing posts to a mock by mistake.

// .env.example and Compose set empty strings for unset values.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const PLATFORM_MODES = ['mock', 'live', 'off'] as const;
export type PlatformMode = (typeof PLATFORM_MODES)[number];

const mode = z.preprocess(unsetIfEmpty, z.enum(PLATFORM_MODES).default('mock'));
const optionalText = z.preprocess(unsetIfEmpty, z.string().trim().min(1).optional());
const flag = z.preprocess(unsetIfEmpty, z.stringbool().default(false));

export const platformEnvSchema = z.object({
  PLATFORM_MODE_LINKEDIN: mode,
  PLATFORM_MODE_META: mode,
  PLATFORM_MODE_X: mode,
  // Real adapters refresh tokens and validate, but send nothing (architecture 16).
  PUBLISH_DRY_RUN: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
  // The apps of the live platforms (docs/plattformen-einrichten.md). Checked when a live adapter is
  // built (live-adapters.ts), so that a platform in mock or off mode needs none of them.
  LINKEDIN_CLIENT_ID: optionalText,
  LINKEDIN_CLIENT_SECRET: optionalText,
  LINKEDIN_VERSION: optionalText,
  LINKEDIN_MEMBER_POST_ANALYTICS: flag,
  LINKEDIN_MEMBER_FOLLOWER_STATISTICS: flag,
  LINKEDIN_ORGANIZATIONS: flag,
  META_APP_ID: optionalText,
  META_APP_SECRET: optionalText,
  META_GRAPH_VERSION: optionalText,
  META_FACEBOOK_LOGIN_CONFIG_ID: optionalText,
  META_INSTAGRAM_LOGIN_CONFIG_ID: optionalText,
  META_PUBLIC_MEDIA_BASE_URL: optionalText,
  X_CLIENT_ID: optionalText,
  X_CLIENT_SECRET: optionalText,
  X_APP_OWNER_USER_ID: optionalText,
});
export type PlatformEnv = z.infer<typeof platformEnvSchema>;

type PlatformModeVariable = 'PLATFORM_MODE_LINKEDIN' | 'PLATFORM_MODE_META' | 'PLATFORM_MODE_X';

export const PLATFORM_MODE_VARIABLES: Readonly<Record<Platform, PlatformModeVariable>> = {
  LINKEDIN: 'PLATFORM_MODE_LINKEDIN',
  FACEBOOK: 'PLATFORM_MODE_META',
  INSTAGRAM: 'PLATFORM_MODE_META',
  X: 'PLATFORM_MODE_X',
};

export const platformModeOf = (
  env: Pick<PlatformEnv, PlatformModeVariable>,
  platform: Platform,
): PlatformMode => env[PLATFORM_MODE_VARIABLES[platform]];

/** True when the platform runs against the mock, which never happens in production. */
export const usesMockPlatform = (
  env: Pick<PlatformEnv, PlatformModeVariable> & { NODE_ENV: string },
  platform: Platform,
): boolean => env.NODE_ENV !== 'production' && platformModeOf(env, platform) === 'mock';
