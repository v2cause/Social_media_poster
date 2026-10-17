import {
  accountMetrics,
  canary,
  deletePost,
  postMetrics,
  publish,
  reconcile,
  verifySession,
  type FlowContext,
} from '@smp/x-browser';

import type { XbFlows } from './command-runner';

// The commands of the queue on the flows of a selector map (guide step 6.3).
export function flowsOf(ctx: FlowContext): XbFlows {
  return {
    selectorsVersion: ctx.selectors.version,
    publish: (page, command, media) =>
      publish(page, ctx, { text: command.text, media, handle: command.target.handle }),
    reconcile: async (page, command) => ({
      found: await reconcile(page, ctx, {
        handle: command.target.handle,
        text: command.text,
        since: new Date(command.since),
      }),
    }),
    metrics: async (page, command) => ({
      items: await postMetrics(page, ctx, {
        handle: command.target.handle,
        externalPostIds: command.externalPostIds,
      }),
    }),
    'account-metrics': (page, command) => accountMetrics(page, ctx, { handle: command.target.handle }),
    delete: async (page, command) => {
      await deletePost(page, ctx, { handle: command.target.handle, externalPostId: command.externalPostId });
      return {};
    },
    'verify-session': async (page) => ({ user: await verifySession(page, ctx) }),
    canary: async (page) => ({ missing: await canary(page, ctx) }),
  };
}
