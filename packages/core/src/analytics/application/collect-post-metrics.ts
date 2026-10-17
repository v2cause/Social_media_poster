import type { PostMetricsResult } from '../../channels/ports/platform-adapter';
import { METRICS_BATCH_SIZE, nextPollAfter } from '../domain/cadence';
import { engagementsOf } from '../domain/metrics';
import type { AnalyticsStore, DueVariant, VariantPoll } from '../ports/analytics';
import {
  accessAccount,
  CallCosts,
  contextOf,
  POLL_RETRY_MS,
  pollWaitAfter,
  requestRollup,
  unitOf,
  type AccountAccess,
  type AnalyticsJobDependencies,
  type AnalyticsJobInput,
} from './analytics-job';

// The collector of post metrics (guide step 5.2, architecture 8). The job metrics.post of an
// account claims its due variants in batches of the size the platform reads at once, asks the
// adapter and stores per variant a snapshot, the latest numbers and its next poll; polls whose
// time passed meanwhile are skipped. A post the platform no longer knows is marked as deleted on
// the platform and polled no more; a variant without an answer is asked for again later. The
// read costs of X are booked per batch.

/** How long the claim of a batch lasts; the variants of a run that died are due again after it. */
export const METRICS_LEASE_MS = 15 * 60 * 1000;
/** Batches per run; the next tick takes the rest. */
const MAX_BATCHES = 20;

export interface CollectPostMetricsResult {
  polled: number;
  deleted: number;
  postponed: number;
  ended: number;
}

type ReadyAccess = Extract<AccountAccess, { kind: 'ready' }>;

export class CollectPostMetrics {
  constructor(private readonly deps: AnalyticsJobDependencies) {}

  async execute(input: AnalyticsJobInput): Promise<CollectPostMetricsResult> {
    const result: CollectPostMetricsResult = { polled: 0, deleted: 0, postponed: 0, ended: 0 };
    const { deps } = this;
    const access = await accessAccount(deps, input);
    const now = deps.clock.now();
    switch (access.kind) {
      case 'missing':
        return result;
      case 'disconnected':
        // A disconnected account stays for the history of its posts, without further polls.
        result.ended = await unitOf(deps, input, (store) =>
          store.postMetrics.endDue(input.workspaceId, input.accountId, now),
        );
        return result;
      case 'unusable':
      case 'no_adapter':
        result.postponed = await unitOf(deps, input, (store) =>
          store.postMetrics.postponeDue(
            input.workspaceId,
            input.accountId,
            now,
            new Date(now.getTime() + POLL_RETRY_MS.access),
          ),
        );
        return result;
      case 'ready':
        break;
    }
    const batchSize = METRICS_BATCH_SIZE[access.target.account.platform];
    // The snapshots go to the days they were taken; a first poll also counts its post as
    // published on its day.
    const touched: Date[] = [];
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const claimedAt = deps.clock.now();
      const due = await unitOf(deps, input, (store) =>
        store.postMetrics.claimDue(
          input.workspaceId,
          input.accountId,
          claimedAt,
          batchSize,
          new Date(claimedAt.getTime() + METRICS_LEASE_MS),
        ),
      );
      if (
        due.length === 0 ||
        !(await this.poll(input, access, due, result, touched)) ||
        due.length < batchSize
      ) {
        break;
      }
    }
    await requestRollup(deps, input, touched);
    return result;
  }

  /** Polls one batch; false when the account has to wait. */
  private async poll(
    input: AnalyticsJobInput,
    access: ReadyAccess,
    due: readonly DueVariant[],
    result: CollectPostMetricsResult,
    touched: Date[],
  ): Promise<boolean> {
    const { deps } = this;
    const costs = new CallCosts();
    const context = () => contextOf(deps, input, access, costs);
    let answers: PostMetricsResult[];
    try {
      await access.tokens.refresh(context, false);
      answers = await access.tokens.withToken(context, (ctx) =>
        access.adapter.fetchPostMetrics(
          due.map(({ externalPostId, externalUrl }) => ({ externalPostId, externalUrl })),
          ctx,
        ),
      );
    } catch (error) {
      const wait = input.signal.aborted ? null : pollWaitAfter(error);
      if (wait === null) {
        // Not an answer of the platform: the claim runs out and a later tick tries again.
        throw error;
      }
      const at = new Date(deps.clock.now().getTime() + wait);
      await unitOf(deps, input, async (store) => {
        await store.postMetrics.postpone(
          input.workspaceId,
          due.map((variant) => variant.id),
          at,
        );
        await this.book(store, costs, input, access);
      });
      deps.logger.warn(
        { accountId: input.accountId, variants: due.length, err: error, retryAt: at.toISOString() },
        'analytics.poll_postponed',
      );
      result.postponed += due.length;
      return false;
    }

    const capturedAt = deps.clock.now();
    const { platform } = access.target.account;
    const byPost = new Map(answers.map((answer) => [answer.externalPostId, answer]));
    const polls: VariantPoll[] = [];
    const unanswered: string[] = [];
    for (const variant of due) {
      const answer = byPost.get(variant.externalPostId);
      if (!answer) {
        unanswered.push(variant.id);
      } else if (answer.kind === 'deleted') {
        polls.push({ kind: 'deleted', variantId: variant.id, publishedAt: variant.publishedAt });
      } else {
        polls.push({
          kind: 'metrics',
          variantId: variant.id,
          publishedAt: variant.publishedAt,
          step: variant.step,
          metrics: answer.metrics,
          engagements: engagementsOf(answer.metrics),
          raw: answer.raw,
          mappingVersion: answer.mappingVersion,
          next: nextPollAfter(
            platform,
            access.adapter.method,
            variant.publishedAt,
            variant.step,
            capturedAt,
            deps.cadenceScale,
          ),
        });
      }
    }
    await unitOf(deps, input, async (store) => {
      await store.postMetrics.record(input.workspaceId, { id: input.accountId, platform }, capturedAt, polls);
      if (unanswered.length > 0) {
        await store.postMetrics.postpone(
          input.workspaceId,
          unanswered,
          new Date(capturedAt.getTime() + POLL_RETRY_MS.other),
        );
      }
      await this.book(store, costs, input, access);
    });
    for (const poll of polls) {
      if (poll.kind === 'metrics') {
        touched.push(capturedAt, ...(poll.step === 0 ? [poll.publishedAt] : []));
      }
    }
    const deleted = polls.filter((poll) => poll.kind === 'deleted').length;
    result.deleted += deleted;
    result.polled += polls.length - deleted;
    result.postponed += unanswered.length;
    return true;
  }

  private async book(
    store: AnalyticsStore,
    costs: CallCosts,
    input: AnalyticsJobInput,
    access: ReadyAccess,
  ): Promise<void> {
    const entries = costs.entries(this.deps, input, access.target, this.deps.ids.newId());
    if (entries.length > 0) {
      await store.costs.record(entries);
    }
  }
}
