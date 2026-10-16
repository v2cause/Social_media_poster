import { randomUUID } from 'node:crypto';

import { systemClock, type AdapterContext, type PublishRequest } from '@smp/core';
import { PLATFORMS, capabilitiesOf, type Platform } from '@smp/platform-rules';
import { describeAdapterContract } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { InMemoryMockPlatformStore } from './mock-platform-store';
import { MockPlatformAdapter } from './mock-platform-adapter';

// Guide step 4.4, "Fertig, wenn": the mock adapter passes the contract suite, for all platforms.

const ACCOUNT_TYPES = {
  LINKEDIN: ['PROFILE', 'PAGE'],
  FACEBOOK: ['PAGE'],
  INSTAGRAM: ['BUSINESS'],
  X: ['PROFILE'],
} as const;

const contextFor = (platform: Platform, settings: Record<string, unknown> = {}): AdapterContext => ({
  account: {
    id: randomUUID(),
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    platform,
    type: ACCOUNT_TYPES[platform][0],
    externalId: `mock-${platform.toLowerCase()}`,
    name: 'Mira Mock',
    handle: null,
    settings,
  },
  credentials: {
    accessToken: () => Promise.resolve('mock-access'),
    refreshToken: () => Promise.resolve(null),
  },
  costs: { record: () => Promise.resolve() },
  logger: { info: () => undefined, warn: () => undefined },
  signal: new AbortController().signal,
  dryRun: false,
});

const requestFor = (platform: Platform, text: string): PublishRequest => ({
  variantId: randomUUID(),
  text,
  firstComment: null,
  linkUrl: null,
  media:
    platform === 'INSTAGRAM'
      ? [
          {
            url: 'https://storage.example/a.jpg',
            mimeType: 'image/jpeg',
            width: 1080,
            height: 1350,
            sizeBytes: 200_000,
            altText: null,
          },
        ]
      : [],
  contentHash: `hash-${randomUUID()}`,
});

for (const platform of PLATFORMS) {
  const store = new InMemoryMockPlatformStore();
  describeAdapterContract(
    { describe, it, expect },
    `mock ${platform}`,
    () =>
      new MockPlatformAdapter(platform, {
        store,
        clock: systemClock,
        authorizeUrl: 'http://localhost:3000/api/dev/mock-oauth/authorize',
      }),
    {
      accountTypes: ACCOUNT_TYPES[platform],
      context: (options = {}) => contextFor(platform, { ...options }),
      validRequest: () => requestFor(platform, 'Unsere neue Werkstatt in Kiel ist fertig. #Handwerk'),
      invalidRequest: () => requestFor(platform, 'x'.repeat(capabilitiesOf(platform).text.maxLength + 1)),
    },
  );
}
