import { systemClock, type SocialPlatformAdapter } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { createAdapterRegistry, PlatformConfigError } from './create-registry';
import { platformEnvSchema, usesMockPlatform } from './env';
import { InMemoryMockPlatformStore } from './mock/mock-platform-store';
import { MockPlatformAdapter } from './mock/mock-platform-adapter';

// The registry follows PLATFORM_MODE_* (guide step 4.4): mock adapters outside production only,
// and a live platform without its adapter stops the start.

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
