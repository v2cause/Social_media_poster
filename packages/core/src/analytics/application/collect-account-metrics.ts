import { ReauthRequiredError } from '../../channels/application/connection-tokens';
import { isPlatformError } from '../../channels/domain/platform-error';
import { localDayRange } from '../domain/days';
import {
  accessAccount,
  CallCosts,
  contextOf,
  requestRollup,
  unitOf,
  type AccountAccess,
  type AnalyticsJobDependencies,
  type AnalyticsJobInput,
} from './analytics-job';

// The daily numbers of an account (guide step 5.2, architecture 8): followers, reach and profile
// views of a day in the time zone of the workspace, polled once the day is over. A failure that
// passes is left to the backoff of the queue; one that does not is logged and skipped, and the
// next day brings new numbers.

export interface CollectAccountMetricsInput extends AnalyticsJobInput {
  /** The day in the time zone of the workspace, YYYY-MM-DD. */
  day: string;
}

export type CollectAccountMetricsResult =
  { saved: true } | { saved: false; reason: Exclude<AccountAccess['kind'], 'ready'> | 'refused' };

export class CollectAccountMetrics {
  constructor(private readonly deps: AnalyticsJobDependencies) {}

  async execute(input: CollectAccountMetricsInput): Promise<CollectAccountMetricsResult> {
    const { deps } = this;
    const access = await accessAccount(deps, input);
    if (access.kind !== 'ready') {
      return { saved: false, reason: access.kind };
    }
    const timeZone =
      (await unitOf(deps, input, (store) => store.workspaces.timeZoneOf(input.workspaceId))) ?? 'UTC';
    const range = localDayRange(input.day, timeZone);
    const costs = new CallCosts();
    const context = () => contextOf(deps, input, access, costs);
    try {
      await access.tokens.refresh(context, false);
      const metrics = await access.tokens.withToken(context, (ctx) =>
        access.adapter.fetchAccountMetrics(range, ctx),
      );
      await unitOf(deps, input, async (store) => {
        await store.accountMetrics.saveDaily({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          platform: access.target.account.platform,
          day: input.day,
          followers: metrics.followers,
          reach: metrics.reach,
          profileViews: metrics.profileViews,
          raw: metrics.raw,
          mappingVersion: metrics.mappingVersion,
          capturedAt: deps.clock.now(),
        });
        const entries = costs.entries(deps, input, access.target, deps.ids.newId());
        if (entries.length > 0) {
          await store.costs.record(entries);
        }
      });
      await requestRollup(deps, input, [range.from]);
      return { saved: true };
    } catch (error) {
      const refused = error instanceof ReauthRequiredError || (isPlatformError(error) && !error.retryable);
      if (input.signal.aborted || !refused) {
        throw error;
      }
      deps.logger.warn(
        { accountId: input.accountId, day: input.day, err: error },
        'analytics.account_refused',
      );
      return { saved: false, reason: 'refused' };
    }
  }
}
