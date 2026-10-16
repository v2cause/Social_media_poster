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

export const platformEnvSchema = z.object({
  PLATFORM_MODE_LINKEDIN: mode,
  PLATFORM_MODE_META: mode,
  PLATFORM_MODE_X: mode,
  // Real adapters refresh tokens and validate, but send nothing (architecture 16).
  PUBLISH_DRY_RUN: z.preprocess(unsetIfEmpty, z.stringbool().default(false)),
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
