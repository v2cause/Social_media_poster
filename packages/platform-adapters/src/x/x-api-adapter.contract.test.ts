import { randomUUID } from 'node:crypto';

import type { AdapterContext, PublishRequest } from '@smp/core';
import { describeAdapterContract } from '@smp/testing';
import { describe, expect, it } from 'vitest';

import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_USER, FakeXApi } from './fake-x-api';
import { createXAdapter } from './index';

// Guide step 4.14, "Fertig, wenn" (first part): the X API adapter passes the contract suite
// against answers shaped like the real ones (fake-x-api.ts).

const contextFor = (options: { failStatus?: number; retryAfterSeconds?: number } = {}): AdapterContext => {
  const token =
    options.failStatus === undefined
      ? 'access-contract'
      : `fail-${String(options.failStatus)}${options.retryAfterSeconds === undefined ? '' : `-${String(options.retryAfterSeconds)}`}`;
  return {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform: 'X',
      type: 'PROFILE',
      externalId: FAKE_USER.id,
      name: FAKE_USER.name,
      handle: FAKE_USER.username,
      settings: {},
    },
    credentials: {
      accessToken: () => Promise.resolve(token),
      refreshToken: () => Promise.resolve(null),
    },
    costs: { record: () => Promise.resolve() },
    logger: { info: () => undefined, warn: () => undefined },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive: () => Promise.resolve(),
  };
};

const requestFor = (text: string): PublishRequest => ({
  variantId: randomUUID(),
  text,
  firstComment: null,
  linkUrl: null,
  media: [],
  contentHash: `hash-${randomUUID()}`,
});

describeAdapterContract(
  { describe, it, expect },
  'X API',
  () =>
    createXAdapter({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      fetch: new FakeXApi().fetch,
    }),
  {
    accountTypes: ['PROFILE'],
    context: (options = {}) => contextFor(options),
    // X refuses the same text twice, so every valid post differs.
    validRequest: () =>
      requestFor(`Unsere neue Werkstatt in Kiel ist fertig. #Handwerk ${randomUUID().slice(0, 8)}`),
    invalidRequest: () => requestFor('x'.repeat(281)),
  },
);
