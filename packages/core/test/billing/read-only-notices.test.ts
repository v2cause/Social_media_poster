import { describe, expect, it } from 'vitest';

import { AnnounceReadOnly, readOnlyReasonOf, type ReadOnlyNotices, type SubscriptionStatus } from '../../src';
import { RecordingBillingNotifier } from '../in-memory-billing';
import { MovingClock } from '../in-memory-publish-job';

// Guide step 7.4: once an organization is read-only, its owners hear of it once, with the reason.

const NOW = Date.parse('2026-10-17T12:00:00Z');

class MemoryNotices implements ReadOnlyNotices {
  readonly rows: {
    organizationId: string;
    status: SubscriptionStatus;
    readOnlyAt: Date;
    sentAt: Date | null;
  }[] = [];

  due(now: Date, limit: number) {
    return Promise.resolve(
      this.rows
        .filter((row) => row.readOnlyAt <= now && row.sentAt === null)
        .slice(0, limit)
        .map(({ organizationId, status, readOnlyAt }) => ({ organizationId, status, readOnlyAt })),
    );
  }

  markSent(organizationId: string, readOnlyAt: Date, at: Date) {
    for (const row of this.rows) {
      if (row.organizationId === organizationId && row.readOnlyAt.getTime() === readOnlyAt.getTime()) {
        row.sentAt = at;
      }
    }
    return Promise.resolve();
  }
}

describe('the notice of a read-only organization', () => {
  it('names why the organization is read-only', () => {
    expect(readOnlyReasonOf('TRIALING')).toBe('trial');
    expect(readOnlyReasonOf('PAST_DUE')).toBe('payment');
    expect(readOnlyReasonOf('UNPAID')).toBe('payment');
    expect(readOnlyReasonOf('INCOMPLETE_EXPIRED')).toBe('payment');
    expect(readOnlyReasonOf('CANCELED')).toBe('ended');
    expect(readOnlyReasonOf('PAUSED')).toBe('ended');
  });

  it('tells the owners once, and tries again where the notice failed', async () => {
    const notices = new MemoryNotices();
    const notifier = new RecordingBillingNotifier();
    const clock = new MovingClock(NOW);
    const at = (iso: string) => new Date(iso);
    notices.rows.push(
      {
        organizationId: 'org-trial',
        status: 'TRIALING',
        readOnlyAt: at('2026-10-17T08:00:00Z'),
        sentAt: null,
      },
      {
        organizationId: 'org-unpaid',
        status: 'PAST_DUE',
        readOnlyAt: at('2026-10-16T08:00:00Z'),
        sentAt: null,
      },
      // Still writable for a day.
      {
        organizationId: 'org-later',
        status: 'PAST_DUE',
        readOnlyAt: at('2026-10-18T08:00:00Z'),
        sentAt: null,
      },
    );
    notifier.failingFor.add('org-unpaid');
    const announce = new AnnounceReadOnly({ notices, notifier, clock });

    await expect(announce.execute()).resolves.toEqual({ announced: 1, failed: 1 });
    notifier.failingFor.clear();
    await expect(announce.execute()).resolves.toEqual({ announced: 1, failed: 0 });
    await expect(announce.execute()).resolves.toEqual({ announced: 0, failed: 0 });

    expect(notifier.readOnlyNotices).toEqual([
      { organizationId: 'org-trial', readOnlyAt: at('2026-10-17T08:00:00Z'), reason: 'trial' },
      { organizationId: 'org-unpaid', readOnlyAt: at('2026-10-16T08:00:00Z'), reason: 'payment' },
    ]);
  });
});
