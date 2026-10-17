import type { AnalyticsScope, AnalyticsUnitOfWork } from '../ports/analytics';

// The rollup of guide step 5.3: the days of a workspace in its time zone, filled from the deltas
// of consecutive snapshots, the published posts and the daily numbers of the accounts. It runs
// after each run of the collector for the days it touched, and every night over the last 35 days.

/** The days the nightly run fills again: late polls and corrections reach that far back. */
export const NIGHTLY_ROLLUP_DAYS = 35;

export interface RollUpAnalyticsInput extends AnalyticsScope {
  from: string;
  to: string;
}

export class RollUpAnalytics {
  constructor(private readonly deps: { unitOfWork: AnalyticsUnitOfWork }) {}

  async execute(input: RollUpAnalyticsInput): Promise<{ rows: number }> {
    const rows = await this.deps.unitOfWork.run(input, (store) =>
      store.rollups.rollUp(input.workspaceId, input.from, input.to),
    );
    return { rows };
  }
}
