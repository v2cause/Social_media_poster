import { describe, expect, it } from 'vitest';

import {
  AI_RAW_DATA_DAYS,
  ApplyRetention,
  CONNECTION_DATA_DAYS,
  MIN_METRICS_DAYS,
  PROCESSED_WEBHOOK_DAYS,
  type RetentionStore,
} from '../../src';
import { fixedClock } from '../in-memory-content';

// Guide step 8.3: every night the raw data of AI generations goes after 180 days, processed
// webhook events and connection data after 30 days and the metrics of an organization beyond the
// history of its plan, but never within the days the nightly rollup fills again. Large amounts go in batches, and an
// organization whose plan cannot be read waits for the next night.

const NOW = '2026-10-18T03:41:00Z';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.parse(NOW) - days * DAY);

class MemoryRetention implements RetentionStore {
  readonly ai: { createdAt: Date; raw: boolean }[] = [];
  webhooks: { processedAt: Date | null }[] = [];
  /** Connection data by the moment it counts from: created, expired or last used. */
  readonly connections: { since: Date; held: boolean }[] = [];
  readonly metrics = new Map<string, Date[]>();
  readonly metricCutoffs = new Map<string, Date>();
  calls = 0;

  clearAiRawData(createdBefore: Date, limit: number): Promise<number> {
    this.calls += 1;
    // Stops at the limit, like the statement, so that the test of the batches stays fast.
    let cleared = 0;
    for (const row of this.ai) {
      if (cleared === limit) {
        break;
      }
      if (row.raw && row.createdAt < createdBefore) {
        row.raw = false;
        cleared += 1;
      }
    }
    return Promise.resolve(cleared);
  }

  deleteProcessedWebhooks(processedBefore: Date, limit: number): Promise<number> {
    const due = this.webhooks
      .filter((event) => event.processedAt !== null && event.processedAt < processedBefore)
      .slice(0, limit);
    this.webhooks = this.webhooks.filter((event) => !due.includes(event));
    return Promise.resolve(due.length);
  }

  clearConnectionData(before: Date, limit: number): Promise<number> {
    const due = this.connections.filter((row) => row.held && row.since < before).slice(0, limit);
    for (const row of due) {
      row.held = false;
    }
    return Promise.resolve(due.length);
  }

  organizations(after: string | null, limit: number): Promise<string[]> {
    const ids = [...this.metrics.keys()].sort().filter((id) => after === null || id > after);
    return Promise.resolve(ids.slice(0, limit));
  }

  deleteMetrics(organizationId: string, before: Date, limit: number): Promise<number> {
    this.metricCutoffs.set(organizationId, before);
    const rows = this.metrics.get(organizationId) ?? [];
    const due = rows.filter((moment) => moment < before).slice(0, limit);
    this.metrics.set(
      organizationId,
      rows.filter((moment) => !due.includes(moment)),
    );
    return Promise.resolve(due.length);
  }
}

const retention = (store: RetentionStore, plans: Record<string, number>) =>
  new ApplyRetention({
    store,
    analyticsHistoryDays: (organizationId) => {
      const days = plans[organizationId];
      return days === undefined ? Promise.reject(new Error('no plan')) : Promise.resolve(days);
    },
    clock: fixedClock(NOW),
  });

describe('ApplyRetention', () => {
  it('clears old raw data of AI and connection data and deletes old processed webhook events', async () => {
    const store = new MemoryRetention();
    store.ai.push(
      { createdAt: daysAgo(AI_RAW_DATA_DAYS + 1), raw: true },
      { createdAt: daysAgo(AI_RAW_DATA_DAYS - 1), raw: true },
    );
    store.webhooks = [
      { processedAt: daysAgo(PROCESSED_WEBHOOK_DAYS + 1) },
      { processedAt: daysAgo(PROCESSED_WEBHOOK_DAYS - 1) },
      // Waiting events stay, however old.
      { processedAt: null },
    ];
    store.connections.push(
      { since: daysAgo(CONNECTION_DATA_DAYS + 1), held: true },
      { since: daysAgo(CONNECTION_DATA_DAYS - 1), held: true },
    );

    await expect(retention(store, {}).execute()).resolves.toEqual({
      aiRawDataCleared: 1,
      webhooksDeleted: 1,
      connectionDataCleared: 1,
      metricsDeleted: 0,
      metricsFailed: 0,
    });
    expect(store.ai.map((row) => row.raw)).toEqual([false, true]);
    expect(store.connections.map((row) => row.held)).toEqual([false, true]);
    expect(store.webhooks).toEqual([
      { processedAt: daysAgo(PROCESSED_WEBHOOK_DAYS - 1) },
      { processedAt: null },
    ]);
  });

  it('keeps the metrics of the history of the plan, and never fewer days than the nightly rollup needs', async () => {
    const store = new MemoryRetention();
    store.metrics.set('org-agency', [daysAgo(731), daysAgo(729)]);
    store.metrics.set('org-starter', [daysAgo(91), daysAgo(89)]);
    store.metrics.set('org-trial', [daysAgo(MIN_METRICS_DAYS + 1), daysAgo(31), daysAgo(1)]);

    const report = await retention(store, {
      'org-agency': 730,
      'org-starter': 90,
      'org-trial': 30,
    }).execute();

    expect(report).toMatchObject({ metricsDeleted: 3, metricsFailed: 0 });
    expect(store.metricCutoffs).toEqual(
      new Map([
        ['org-agency', daysAgo(730)],
        ['org-starter', daysAgo(90)],
        // Thirty days of the trial, but the rollup fills the last 35 days again.
        ['org-trial', daysAgo(MIN_METRICS_DAYS)],
      ]),
    );
    expect(store.metrics.get('org-trial')).toEqual([daysAgo(31), daysAgo(1)]);
  });

  it('goes through every organization page by page and skips one whose plan cannot be read', async () => {
    const store = new MemoryRetention();
    const plans: Record<string, number> = {};
    for (let index = 0; index < 450; index += 1) {
      const id = `org-${String(index).padStart(3, '0')}`;
      store.metrics.set(id, [daysAgo(400)]);
      plans[id] = 90;
    }
    delete plans['org-123'];

    await expect(retention(store, plans).execute()).resolves.toMatchObject({
      metricsDeleted: 449,
      metricsFailed: 1,
    });
    expect(store.metrics.get('org-123')).toEqual([daysAgo(400)]);
    expect(store.metrics.get('org-449')).toEqual([]);
  });

  it('works in batches and leaves what is beyond the batches of a night for the next one', async () => {
    const store = new MemoryRetention();
    for (let index = 0; index < 100_500; index += 1) {
      store.ai.push({ createdAt: daysAgo(AI_RAW_DATA_DAYS + 2), raw: true });
    }

    await expect(retention(store, {}).execute()).resolves.toMatchObject({ aiRawDataCleared: 100_000 });
    expect(store.calls).toBe(100);
    await expect(retention(store, {}).execute()).resolves.toMatchObject({ aiRawDataCleared: 500 });
  });
});
