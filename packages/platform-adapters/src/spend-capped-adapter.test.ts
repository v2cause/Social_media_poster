import { randomUUID } from 'node:crypto';

import { isPlatformError, PlatformError, type AdapterContext, type PublishRequest } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { InMemoryMockPlatformStore } from './mock/mock-platform-store';
import { MockPlatformAdapter } from './mock/mock-platform-adapter';
import { isSpendCapped, spendCappedAdapter } from './spend-capped-adapter';

// Guide step 7.4: an X API call that would pass the spending cap of the month fails before it is
// sent; the browser of X and the other platforms cost nothing per call.

const ORG = randomUUID();

const setup = (remainingMicros: number) => {
  const store = new InMemoryMockPlatformStore();
  const clock = { now: () => new Date('2026-10-16T10:00:00Z') };
  const inner = new MockPlatformAdapter('X', { store, clock, authorizeUrl: 'http://localhost:3000/oauth' });
  const asked: number[] = [];
  const adapter = spendCappedAdapter(inner, ORG, {
    assertRoom: (organizationId, costMicros) => {
      asked.push(costMicros);
      return organizationId === ORG && costMicros <= remainingMicros
        ? Promise.resolve()
        : Promise.reject(new PlatformError('SPEND_CAP_REACHED', 'cap'));
    },
  });
  const ctx: AdapterContext = {
    account: {
      id: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      platform: 'X',
      type: 'PROFILE',
      externalId: 'u-x',
      name: 'Mira',
      handle: 'mira',
      settings: {},
    },
    credentials: { accessToken: () => Promise.resolve('a'), refreshToken: () => Promise.resolve('r') },
    costs: { record: () => Promise.resolve() },
    logger: { info: () => undefined, warn: () => undefined },
    signal: new AbortController().signal,
    dryRun: false,
    keepAlive: () => Promise.resolve(),
  };
  const request: PublishRequest = {
    variantId: randomUUID(),
    text: 'Hallo Kiel',
    firstComment: null,
    linkUrl: null,
    media: [],
    contentHash: 'h1',
  };
  return { store, inner, adapter, ctx, request, asked };
};

describe('spendCappedAdapter', () => {
  it('caps the paid calls of X through the API and the mock, not the browser or other platforms', () => {
    expect(isSpendCapped(setup(0).inner)).toBe(true);
    expect(isSpendCapped({ platform: 'X', method: 'BROWSER' })).toBe(false);
    expect(isSpendCapped({ platform: 'LINKEDIN', method: 'API' })).toBe(false);
  });

  it('posts while the price fits, and a post with a link costs more', async () => {
    const { adapter, ctx, request, asked, store } = setup(20_000);

    await expect(adapter.publish(request, ctx)).resolves.toHaveProperty('externalPostId');
    const refused = await adapter
      .publish({ ...request, linkUrl: 'https://example.test' }, ctx)
      .catch((error: unknown) => error);

    expect(isPlatformError(refused) && refused.code).toBe('SPEND_CAP_REACHED');
    expect(asked).toEqual([15_000, 200_000]);
    expect(await store.callCount('created', ctx.account.id)).toBe(1);
  });

  it('sends nothing past the cap, and a reconcile and the free calls pass', async () => {
    const { adapter, ctx, request, asked } = setup(0);

    await expect(
      adapter.fetchPostMetrics(
        [
          { externalPostId: 'a', externalUrl: null },
          { externalPostId: 'b', externalUrl: null },
        ],
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'SPEND_CAP_REACHED' });
    await expect(
      adapter.reconcile({ text: request.text, since: new Date(0), contentHash: 'h1' }, ctx),
    ).resolves.toBeNull();
    expect(adapter.validatePost(request, 'PROFILE')).toEqual([]);
    expect(asked).toEqual([10_000]);
  });
});
