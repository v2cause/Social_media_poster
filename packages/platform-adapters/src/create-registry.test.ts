import { systemClock, type SocialPlatformAdapter } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { createAdapterRegistry, PlatformConfigError } from './create-registry';
import { checkPlatformEnv, platformEnvSchema, usesMockPlatform } from './env';
import { liveAdapters } from './live/live-adapters';
import { InMemoryMockPlatformStore } from './mock/mock-platform-store';
import { MockPlatformAdapter } from './mock/mock-platform-adapter';

// The registry follows PLATFORM_MODE_* (guide step 4.4): mock adapters outside production only,
// the real adapters of a live platform (guide steps 4.12 to 4.14), and a live platform without
// its adapter stops the start.

const mock = {
  store: new InMemoryMockPlatformStore(),
  clock: systemClock,
  authorizeUrl: 'http://localhost:3000/api/dev/mock-oauth/authorize',
};
const envOf = (values: Record<string, string>, nodeEnv = 'development') => ({
  ...platformEnvSchema.parse(values),
  NODE_ENV: nodeEnv,
});

describe('platformEnvSchema', () => {
  it('defaults to mock without dry run and treats empty values as unset', () => {
    expect(platformEnvSchema.parse({ PLATFORM_MODE_X: '', PUBLISH_DRY_RUN: '' })).toEqual({
      PLATFORM_MODE_LINKEDIN: 'mock',
      PLATFORM_MODE_META: 'mock',
      PLATFORM_MODE_X: 'mock',
      PUBLISH_DRY_RUN: false,
      LINKEDIN_ORGANIZATIONS: false,
      LINKEDIN_MEMBER_ANALYTICS: false,
    });
    expect(platformEnvSchema.parse({ PUBLISH_DRY_RUN: 'true' }).PUBLISH_DRY_RUN).toBe(true);
    expect(platformEnvSchema.safeParse({ PLATFORM_MODE_META: 'fake' }).success).toBe(false);
  });

  it('never uses the mock in production', () => {
    expect(usesMockPlatform(envOf({}), 'INSTAGRAM')).toBe(true);
    expect(usesMockPlatform(envOf({ PLATFORM_MODE_META: 'live' }), 'INSTAGRAM')).toBe(false);
    expect(usesMockPlatform(envOf({}, 'production'), 'INSTAGRAM')).toBe(false);
  });
});

describe('createAdapterRegistry', () => {
  it('registers the mock adapter for every platform in mock mode', () => {
    const registry = createAdapterRegistry({ env: envOf({}), mock });

    expect(registry.methods()).toEqual([
      { platform: 'LINKEDIN', method: 'MOCK' },
      { platform: 'INSTAGRAM', method: 'MOCK' },
      { platform: 'FACEBOOK', method: 'MOCK' },
      { platform: 'X', method: 'MOCK' },
    ]);
  });

  it('offers no platform in mock mode in production', () => {
    expect(createAdapterRegistry({ env: envOf({}, 'production'), mock }).methods()).toEqual([]);
  });

  it('takes the live adapter of the app and refuses a live platform without one', () => {
    // The registry only needs some adapter here; a mock stands in for the real one.
    const built: string[] = [];
    const live = (platform: 'X' | 'FACEBOOK') => (): SocialPlatformAdapter => {
      built.push(platform);
      return new MockPlatformAdapter(platform, mock);
    };
    const registry = createAdapterRegistry({
      env: envOf({ PLATFORM_MODE_X: 'live' }),
      mock,
      live: { X: live('X') },
    });
    expect(built).toEqual(['X']);
    expect(registry.methods()).toHaveLength(4);

    expect(() =>
      createAdapterRegistry({
        env: envOf({ PLATFORM_MODE_META: 'live' }),
        mock,
        live: { FACEBOOK: live('FACEBOOK') },
      }),
    ).toThrow(
      new PlatformConfigError('PLATFORM_MODE_META is live, but there is no live adapter for INSTAGRAM.'),
    );
  });
});

const LIVE_CREDENTIALS = {
  PLATFORM_MODE_LINKEDIN: 'live',
  PLATFORM_MODE_META: 'live',
  PLATFORM_MODE_X: 'live',
  LINKEDIN_CLIENT_ID: 'linkedin-id',
  LINKEDIN_CLIENT_SECRET: 'linkedin-secret',
  LINKEDIN_VERSION: '202510',
  META_APP_ID: 'meta-id',
  META_APP_SECRET: 'meta-secret',
  META_GRAPH_VERSION: 'v24.0',
  X_CLIENT_ID: 'x-id',
};

const issuesOf = (values: Record<string, string>): string[] =>
  platformEnvSchema
    .superRefine(checkPlatformEnv)
    .safeParse(values)
    .error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];

describe('checkPlatformEnv', () => {
  it('asks a live platform for the credentials of its app', () => {
    expect(issuesOf({ PLATFORM_MODE_LINKEDIN: 'live', PLATFORM_MODE_X: 'live' })).toEqual([
      'LINKEDIN_CLIENT_ID: required when PLATFORM_MODE_LINKEDIN is live',
      'LINKEDIN_CLIENT_SECRET: required when PLATFORM_MODE_LINKEDIN is live',
      'LINKEDIN_VERSION: required when PLATFORM_MODE_LINKEDIN is live',
      'X_CLIENT_ID: required when PLATFORM_MODE_X is live',
    ]);
    expect(issuesOf(LIVE_CREDENTIALS)).toEqual([]);
  });

  it('checks the pinned versions and the Instagram app as a pair', () => {
    expect(issuesOf({ ...LIVE_CREDENTIALS, LINKEDIN_VERSION: '2025-10', META_GRAPH_VERSION: '24' })).toEqual([
      'LINKEDIN_VERSION: format YYYYMM',
      'META_GRAPH_VERSION: format vNN.0',
    ]);
    expect(issuesOf({ INSTAGRAM_APP_ID: 'ig-id' })).toEqual([
      'INSTAGRAM_APP_SECRET: INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET are set together or not at all',
    ]);
  });
});

describe('liveAdapters', () => {
  it('builds the real adapters, and leaves Instagram out without its own app', () => {
    const env = envOf(LIVE_CREDENTIALS, 'production');
    const registry = createAdapterRegistry({ env, mock, live: liveAdapters(env, { clock: systemClock }) });

    expect(registry.methods()).toEqual([
      { platform: 'LINKEDIN', method: 'API' },
      { platform: 'FACEBOOK', method: 'API' },
      { platform: 'X', method: 'API' },
    ]);
  });

  it('offers Instagram with its app', () => {
    const env = envOf(
      { ...LIVE_CREDENTIALS, INSTAGRAM_APP_ID: 'ig-id', INSTAGRAM_APP_SECRET: 'ig-secret' },
      'production',
    );
    const registry = createAdapterRegistry({ env, mock, live: liveAdapters(env, { clock: systemClock }) });

    expect(registry.methodFor('INSTAGRAM')).toBe('API');
  });
});
