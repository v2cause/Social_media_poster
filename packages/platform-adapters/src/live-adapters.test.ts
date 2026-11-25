import { systemClock } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { createAdapterRegistry, PlatformConfigError } from './create-registry';
import { platformEnvSchema } from './env';
import { liveAdapters } from './live-adapters';
import { InMemoryMockPlatformStore } from './mock/mock-platform-store';

// The live platforms take their real adapters from the app credentials in the environment.

const mock = { store: new InMemoryMockPlatformStore(), clock: systemClock };

const CREDENTIALS = {
  LINKEDIN_CLIENT_ID: '86abcdefghij12',
  LINKEDIN_CLIENT_SECRET: 'linkedin-secret-value',
  META_APP_ID: '1234567890123456',
  META_APP_SECRET: '0123456789abcdef0123456789abcdef',
  X_CLIENT_ID: 'eEJjbGllbnQtaWQtZm9yLXRlc3Rz',
  X_CLIENT_SECRET: 'x-client-secret-value-for-tests',
};

const envOf = (values: Record<string, string>) => ({
  ...platformEnvSchema.parse(values),
  NODE_ENV: 'development',
});

describe('liveAdapters', () => {
  it('builds the real adapter of every live platform', () => {
    const env = envOf({
      PLATFORM_MODE_LINKEDIN: 'live',
      PLATFORM_MODE_META: 'live',
      PLATFORM_MODE_X: 'live',
      ...CREDENTIALS,
    });

    const registry = createAdapterRegistry({ env, mock, live: liveAdapters(env, { clock: systemClock }) });

    expect(registry.methods()).toEqual([
      { platform: 'LINKEDIN', method: 'API' },
      { platform: 'INSTAGRAM', method: 'API' },
      { platform: 'FACEBOOK', method: 'API' },
      { platform: 'X', method: 'API' },
    ]);
    expect(
      registry.connector('LINKEDIN', 'API')?.authorizationUrl({
        state: 's',
        redirectUri: 'http://localhost:3000/api/oauth/linkedin/callback',
        codeChallenge: null,
      }),
    ).toContain('client_id=86abcdefghij12');
  });

  it('names the missing variables of a live platform, never the values', () => {
    const env = envOf({ PLATFORM_MODE_X: 'live', X_CLIENT_ID: CREDENTIALS.X_CLIENT_ID });

    const build = () => createAdapterRegistry({ env, mock, live: liveAdapters(env, { clock: systemClock }) });

    expect(build).toThrow(PlatformConfigError);
    expect(build).toThrow('X is live, but X_CLIENT_SECRET is not set.');
  });
});
