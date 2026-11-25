import { randomUUID } from 'node:crypto';

import type { AdapterContext, PublishMedia, PublishRequest, SocialAccountType } from '@smp/core';

import { FAKE_ORGANIZATION_URN, FAKE_PERSON_URN, FAKE_STORAGE_URL } from './fake-linkedin';

// Contexts and requests for the tests of the LinkedIn adapter.

export interface TestContextOptions {
  type?: SocialAccountType;
  token?: string;
  refreshToken?: string | null;
  logs?: { level: string; fields: Record<string, unknown>; message: string }[];
}

export function linkedInContext(options: TestContextOptions = {}): AdapterContext {
  const type = options.type ?? 'PROFILE';
  const logs = options.logs ?? [];
  return {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform: 'LINKEDIN',
      type,
      externalId: type === 'PAGE' ? FAKE_ORGANIZATION_URN : FAKE_PERSON_URN,
      name: type === 'PAGE' ? 'Devtestco' : 'John Doe',
      handle: null,
      settings: {},
    },
    credentials: {
      accessToken: () => Promise.resolve(options.token ?? 'AQUvlL_DYEzvT2wz1QJiEPeLioeA'),
      refreshToken: () => Promise.resolve(options.refreshToken ?? null),
    },
    costs: { record: () => Promise.resolve() },
    logger: {
      info: (fields, message) => logs.push({ level: 'info', fields, message }),
      warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive: () => Promise.resolve(),
  };
}

export function imageMedia(name: string, altText: string | null = null): PublishMedia {
  return {
    url: `${FAKE_STORAGE_URL}/renditions/${name}?X-Amz-Signature=abc123`,
    mimeType: 'image/jpeg',
    width: 1200,
    height: 1200,
    sizeBytes: 12,
    altText,
  };
}

export function publishRequest(text: string, overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    variantId: randomUUID(),
    text,
    firstComment: null,
    linkUrl: null,
    media: [],
    contentHash: `hash-${randomUUID()}`,
    ...overrides,
  };
}
