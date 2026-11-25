import { randomUUID } from 'node:crypto';

import { systemClock, type AdapterContext, type PublishRequest, type SocialAccountType } from '@smp/core';
import { capabilitiesOf } from '@smp/platform-rules';
import { describeAdapterContract } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { createFacebookAdapter } from './facebook-adapter';
import { FAKE_APP, FAKE_IG_USER_ID, FAKE_PAGE_ID, FakeGraph } from './fake-graph';
import { createInstagramAdapter } from './instagram-adapter';

// Guide step 4.13: the Meta adapters keep the adapter contract against recorded Graph answers.

function contextFor(
  platform: 'FACEBOOK' | 'INSTAGRAM',
  type: SocialAccountType,
  externalId: string,
  options: { failStatus?: number; retryAfterSeconds?: number } = {},
): AdapterContext {
  const token =
    options.failStatus === undefined
      ? 'page-token-1'
      : `fail-${String(options.failStatus)}${options.retryAfterSeconds === undefined ? '' : `-${String(options.retryAfterSeconds)}`}`;
  return {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform,
      type,
      externalId,
      name: 'Nordlicht',
      handle: null,
      settings: {},
    },
    credentials: { accessToken: () => Promise.resolve(token), refreshToken: () => Promise.resolve(null) },
    costs: { record: () => Promise.resolve() },
    logger: { info: () => undefined, warn: () => undefined },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive: () => Promise.resolve(),
  };
}

const request = (text: string, media: PublishRequest['media'] = []): PublishRequest => ({
  variantId: randomUUID(),
  text,
  firstComment: null,
  linkUrl: null,
  media,
  contentHash: `hash-${randomUUID()}`,
});

const jpeg = {
  url: 'https://cdn.example.com/media/a.jpg?X-Amz-Signature=abc',
  mimeType: 'image/jpeg',
  width: 1080,
  height: 1350,
  sizeBytes: 200_000,
  altText: null,
};

{
  const graph = new FakeGraph();
  describeAdapterContract(
    { describe, it, expect },
    'meta FACEBOOK',
    () => createFacebookAdapter({ app: FAKE_APP, clock: systemClock, fetch: graph.fetch }),
    {
      accountTypes: ['PAGE'],
      context: (options) => contextFor('FACEBOOK', 'PAGE', FAKE_PAGE_ID, options),
      validRequest: () => request(`Unsere neue Werkstatt in Kiel ist fertig. ${randomUUID()}`),
      invalidRequest: () => request('x'.repeat(capabilitiesOf('FACEBOOK').text.maxLength + 1)),
    },
  );
}

{
  const graph = new FakeGraph();
  describeAdapterContract(
    { describe, it, expect },
    'meta INSTAGRAM',
    () => createInstagramAdapter({ app: FAKE_APP, clock: systemClock, fetch: graph.fetch }),
    {
      accountTypes: ['BUSINESS'],
      context: (options) => contextFor('INSTAGRAM', 'BUSINESS', FAKE_IG_USER_ID, options),
      validRequest: () => request(`Unsere neue Werkstatt in Kiel ist fertig. ${randomUUID()}`, [jpeg]),
      invalidRequest: () => request('x'.repeat(capabilitiesOf('INSTAGRAM').text.maxLength + 1), [jpeg]),
    },
  );
}
