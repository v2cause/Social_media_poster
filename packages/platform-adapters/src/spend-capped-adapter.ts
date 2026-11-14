import type { SocialPlatformAdapter, XSpendCap } from '@smp/core';

import { hasLink } from './live/live-support';
import { operationPriceMicros } from './prices';

// The X API costs of an organization within the cap of its plan (guide step 7.4). Before a call
// that costs, the price of the call (prices.ts) and the costs of the month so far must fit, or the
// call fails with SPEND_CAP_REACHED before anything is sent. A reconcile, which finishes an earlier
// attempt and reads a few posts, is not stopped; neither are the free calls. The browser of X
// costs nothing per call and is not wrapped.

/** Whether the adapter calls a paid API whose costs the plan caps. */
export const isSpendCapped = (adapter: Pick<SocialPlatformAdapter, 'platform' | 'method'>): boolean =>
  adapter.platform === 'X' && adapter.method !== 'BROWSER';

const priceOf = (operation: string, units = 1): number => (operationPriceMicros(operation) ?? 0) * units;

export function spendCappedAdapter(
  adapter: SocialPlatformAdapter,
  organizationId: string,
  cap: XSpendCap,
): SocialPlatformAdapter {
  return {
    platform: adapter.platform,
    method: adapter.method,
    connector: adapter.connector,
    capabilities: (type) => adapter.capabilities(type),
    refreshCredentials: (ctx) => adapter.refreshCredentials(ctx),
    validatePost: (request, type) => adapter.validatePost(request, type),
    publish: async (request, ctx) => {
      await cap.assertRoom(
        organizationId,
        priceOf(
          request.linkUrl !== null || hasLink(request.text) ? 'x.post_create_with_url' : 'x.post_create',
        ),
      );
      return adapter.publish(request, ctx);
    },
    reconcile: (query, ctx) => adapter.reconcile(query, ctx),
    deletePost: (ref, ctx) => adapter.deletePost(ref, ctx),
    fetchPostMetrics: async (refs, ctx) => {
      await cap.assertRoom(organizationId, priceOf('x.post_read', refs.length));
      return adapter.fetchPostMetrics(refs, ctx);
    },
    fetchAccountMetrics: (range, ctx) => adapter.fetchAccountMetrics(range, ctx),
  };
}
