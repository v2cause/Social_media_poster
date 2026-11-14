import type { Platform } from '@smp/platform-rules';
import { z } from 'zod';

// The platform settings of the API and the worker (.env.example, architecture 16). Facebook and
// Instagram share one Meta app, so they share one mode:
// - mock: the mock adapter with the fake OAuth page of the API. Outside production only; in
//   production a platform in mock mode is not offered.
// - live: the real adapter with the app credentials of the platform (guide steps 4.12 to 4.14).

// .env.example and Compose set empty strings for unset values.
const unsetIfEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

export const PLATFORM_MODES = ['mock', 'live'] as const;
export type PlatformMode = (typeof PLATFORM_MODES)[number];

const mode = z.preprocess(unsetIfEmpty, z.enum(PLATFORM_MODES).default('mock'));
const optionalText = z.preprocess(unsetIfEmpty, z.string().min(1).optional());
const flag = z.preprocess(unsetIfEmpty, z.stringbool().default(false));

export const platformEnvSchema = z.object({
  PLATFORM_MODE_LINKEDIN: mode,
  PLATFORM_MODE_META: mode,
  PLATFORM_MODE_X: mode,
  // Real adapters refresh tokens and validate, but send nothing (architecture 16).
  PUBLISH_DRY_RUN: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
  // LinkedIn (guide step 4.12): the app with "Sign In with LinkedIn using OpenID Connect" and
  // "Share on LinkedIn". The version of the REST API is pinned as YYYYMM.
  LINKEDIN_CLIENT_ID: optionalText,
  LINKEDIN_CLIENT_SECRET: optionalText,
  LINKEDIN_VERSION: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .regex(/^\d{6}$/, 'format YYYYMM')
      .optional(),
  ),
  // Company pages need the Community Management API on the app; impressions of personal posts
  // need Member Post Analytics. Both are reviewed by LinkedIn, so they are asked for only when on.
  LINKEDIN_ORGANIZATIONS: flag,
  LINKEDIN_MEMBER_ANALYTICS: flag,
  // The second app of architecture 4.2 for the Community Management API; not used yet (ADR 0046).
  LINKEDIN_CM_CLIENT_ID: optionalText,
  LINKEDIN_CM_CLIENT_SECRET: optionalText,
  // Meta (guide step 4.13): Facebook pages through Facebook Login, Instagram through the
  // Instagram API with Instagram Login. The Graph API version is pinned as vNN.0.
  META_APP_ID: optionalText,
  META_APP_SECRET: optionalText,
  META_GRAPH_VERSION: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .regex(/^v\d+\.\d+$/, 'format vNN.0')
      .optional(),
  ),
  // The configuration of Facebook Login for Business; without it the login asks with scopes.
  META_LOGIN_CONFIG_ID: optionalText,
  INSTAGRAM_APP_ID: optionalText,
  INSTAGRAM_APP_SECRET: optionalText,
  // X (guide step 4.14): OAuth 2.0 with PKCE. The secret is set for a confidential client.
  X_CLIENT_ID: optionalText,
  X_CLIENT_SECRET: optionalText,
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

/** The variables a live mode needs; Instagram is optional within Meta, X_CLIENT_SECRET too. */
const REQUIRED_WHEN_LIVE: Readonly<Record<PlatformModeVariable, readonly (keyof PlatformEnv)[]>> = {
  PLATFORM_MODE_LINKEDIN: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_VERSION'],
  PLATFORM_MODE_META: ['META_APP_ID', 'META_APP_SECRET', 'META_GRAPH_VERSION'],
  PLATFORM_MODE_X: ['X_CLIENT_ID'],
};

/**
 * Checks the credentials of every live platform, for the superRefine of the API and the worker.
 * Messages name the variable, never a value.
 */
export function checkPlatformEnv(env: PlatformEnv, context: z.RefinementCtx): void {
  for (const [modeVariable, required] of Object.entries(REQUIRED_WHEN_LIVE) as [
    PlatformModeVariable,
    readonly (keyof PlatformEnv)[],
  ][]) {
    if (env[modeVariable] !== 'live') {
      continue;
    }
    for (const name of required) {
      if (env[name] === undefined) {
        context.addIssue({ code: 'custom', path: [name], message: `required when ${modeVariable} is live` });
      }
    }
  }
  if (Boolean(env.INSTAGRAM_APP_ID) !== Boolean(env.INSTAGRAM_APP_SECRET)) {
    context.addIssue({
      code: 'custom',
      path: ['INSTAGRAM_APP_SECRET'],
      message: 'INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET are set together or not at all',
    });
  }
}
