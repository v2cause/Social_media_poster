import { systemClock, type AdapterLogger, type Clock } from '@smp/core';

import { PlatformHttpClient } from '../http/platform-http-client';
import type { PlatformRateLimiter } from '../rate-limit/platform-rate-limiter';
import { LINKEDIN_DEFAULT_VERSION, linkedInAppConfigSchema, type LinkedInFeatures } from './config';
import { LinkedInApiAdapter } from './linkedin-adapter';

export interface LinkedInAdapterOptions {
  clientId: string;
  clientSecret: string;
  /** LinkedIn-Version, YYYYMM; LINKEDIN_DEFAULT_VERSION when left out. */
  version?: string;
  /** Products beyond Sign In with OpenID Connect and Share on LinkedIn; all off by default. */
  features?: Partial<LinkedInFeatures>;
  clock?: Clock;
  logger?: AdapterLogger;
  /** The shared limiter of the workers (Redis); without one the calls are not throttled. */
  limiter?: PlatformRateLimiter;
  /** The fetch for LinkedIn; tests pass a fake. */
  fetch?: typeof fetch;
  /** The fetch that reads renditions from the storage; the fetch of Node by default. */
  mediaFetch?: typeof fetch;
  /** The largest image the adapter downloads; 20 MB by default. */
  maxImageBytes?: number;
  defaultTimeoutMs?: number;
  /** The wait between image status checks of page images; tests pass one that returns at once. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The real LinkedIn adapter; throws a ZodError when the credentials or the version are malformed. */
export function createLinkedInAdapter(options: LinkedInAdapterOptions): LinkedInApiAdapter {
  const config = linkedInAppConfigSchema.parse({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    version: options.version ?? LINKEDIN_DEFAULT_VERSION,
    features: {
      memberPostAnalytics: options.features?.memberPostAnalytics ?? false,
      memberFollowerStatistics: options.features?.memberFollowerStatistics ?? false,
      organizations: options.features?.organizations ?? false,
    },
  });
  const http = new PlatformHttpClient({
    platform: 'LINKEDIN',
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.limiter ? { limiter: options.limiter } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.defaultTimeoutMs }),
  });
  return new LinkedInApiAdapter(config, {
    http,
    clock: options.clock ?? systemClock,
    ...(options.mediaFetch ? { mediaFetch: options.mediaFetch } : {}),
    ...(options.maxImageBytes === undefined ? {} : { maxImageBytes: options.maxImageBytes }),
    ...(options.wait ? { wait: options.wait } : {}),
  });
}
