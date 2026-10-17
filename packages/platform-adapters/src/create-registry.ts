import type { Clock, SocialPlatformAdapter } from '@smp/core';
import { PLATFORMS, type Platform } from '@smp/platform-rules';

import { PLATFORM_MODE_VARIABLES, platformModeOf, usesMockPlatform, type PlatformEnv } from './env';
import { MockPlatformAdapter } from './mock/mock-platform-adapter';
import type { MockPlatformStore } from './mock/mock-platform-store';
import { AdapterRegistry, type BrowserGate } from './registry';

// Builds the registry from the platform settings (guide step 4.4). A platform in mock mode gets
// the mock adapter outside production and no adapter in production. A live platform needs its
// real adapter from the app, which holds the credentials; without one the start fails.

export class PlatformConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformConfigError';
  }
}

export interface AdapterRegistryOptions {
  env: Pick<PlatformEnv, 'PLATFORM_MODE_LINKEDIN' | 'PLATFORM_MODE_META' | 'PLATFORM_MODE_X'> & {
    NODE_ENV: string;
  };
  mock: {
    store: MockPlatformStore;
    clock: Clock;
    /** The fake OAuth page of the API; the workers leave it out. */
    authorizeUrl?: string;
    defaultLatencyMs?: number;
  };
  /** The real adapters by platform, built with the credentials of the app. */
  live?: Partial<Record<Platform, () => SocialPlatformAdapter>>;
  /** The browser adapter of X with its gate, where the deployment offers it (phase 6). */
  browser?: { adapter: SocialPlatformAdapter; gate: BrowserGate };
}

export function createAdapterRegistry(options: AdapterRegistryOptions): AdapterRegistry {
  const adapters: SocialPlatformAdapter[] = [];
  for (const platform of PLATFORMS) {
    if (platformModeOf(options.env, platform) === 'live') {
      const build = options.live?.[platform];
      if (!build) {
        throw new PlatformConfigError(
          `${PLATFORM_MODE_VARIABLES[platform]} is live, but there is no live adapter for ${platform}.`,
        );
      }
      adapters.push(build());
    } else if (usesMockPlatform(options.env, platform)) {
      adapters.push(new MockPlatformAdapter(platform, options.mock));
    }
  }
  if (options.browser) {
    adapters.push(options.browser.adapter);
  }
  return new AdapterRegistry(adapters, options.browser?.gate);
}
