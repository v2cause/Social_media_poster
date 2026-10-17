import { describe, expect, it } from 'vitest';

import { CollectAccountMetrics, PlatformError } from '../../src';
import { createAnalyticsTestbed, jobOf, type AnalyticsTestbed } from '../in-memory-analytics';
import { NOW } from '../in-memory-publish-job';

// Guide step 5.2: the daily numbers of an account for a day in the time zone of its workspace.

const collect = (bed: AnalyticsTestbed, day = '2026-10-15') =>
  new CollectAccountMetrics(bed).execute({ ...jobOf(), day });

describe('CollectAccountMetrics', () => {
  it('asks for the local day of the workspace and stores its numbers', async () => {
    const bed = createAnalyticsTestbed({ platform: 'X' });
    bed.adapter.duringMetrics = null;

    await expect(collect(bed)).resolves.toEqual({ saved: true });
    expect(bed.adapter.accountRanges).toEqual([
      { from: new Date('2026-10-14T22:00:00Z'), to: new Date('2026-10-15T22:00:00Z') },
    ]);
    expect(bed.unitOfWork.state.daily).toEqual([
      {
        workspaceId: 'ws-1',
        accountId: 'account-1',
        platform: 'X',
        day: '2026-10-15',
        followers: 500,
        reach: 2_000,
        profileViews: 100,
        raw: { followers: 500 },
        mappingVersion: 1,
        capturedAt: new Date(NOW),
      },
    ]);

    bed.adapter.accountAnswers = [
      { followers: 510, reach: null, profileViews: null, raw: {}, mappingVersion: 1 },
    ];
    await collect(bed);
    expect(bed.unitOfWork.state.daily).toEqual([expect.objectContaining({ followers: 510, reach: null })]);
  });

  it('skips a refused poll, leaves one that can pass to the queue, and waits for a connected account', async () => {
    const refused = createAnalyticsTestbed();
    refused.adapter.accountAnswers = [new PlatformError('PERMISSION_DENIED', 'missing scope')];
    await expect(collect(refused)).resolves.toEqual({ saved: false, reason: 'refused' });
    expect(refused.warnings).toEqual(['analytics.account_refused']);

    const busy = createAnalyticsTestbed();
    busy.adapter.accountAnswers = [new PlatformError('TRANSIENT', 'unavailable')];
    await expect(collect(busy)).rejects.toThrow(/unavailable/);

    const disconnected = createAnalyticsTestbed();
    const target = disconnected.unitOfWork.state.targets.get('account-1');
    if (target) {
      target.disconnectedAt = new Date(NOW);
    }
    await expect(collect(disconnected)).resolves.toEqual({ saved: false, reason: 'disconnected' });
    expect(disconnected.adapter.accountRanges).toEqual([]);
  });
});
