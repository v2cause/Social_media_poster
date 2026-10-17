import { describe, expect, it } from 'vitest';

import { RollUpAnalytics } from '../../src';
import { InMemoryAnalytics } from '../in-memory-analytics';

// Guide step 5.3: the rollup runs in the tenant of its workspace for the days asked for.

describe('RollUpAnalytics', () => {
  it('rolls the days up in the tenant of the workspace', async () => {
    const unitOfWork = new InMemoryAnalytics();

    await expect(
      new RollUpAnalytics({ unitOfWork }).execute({
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        from: '2026-09-11',
        to: '2026-10-16',
      }),
    ).resolves.toEqual({ rows: 1 });
    expect(unitOfWork.state.rolledUp).toEqual([
      { workspaceId: 'ws-1', from: '2026-09-11', to: '2026-10-16' },
    ]);
  });
});
