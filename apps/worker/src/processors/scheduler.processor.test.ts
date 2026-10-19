import type { Job, Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { metricsRegistry } from '../metrics';
import type { WorkerEnv } from '../worker-env';
import { plannedAtOf, SchedulerProcessor } from './scheduler.processor';

// Guide step 8.7: every tick reports how late it started and when it last ended with a success
// or a failure, so that an alert sees a tick whose last run failed. Job schedulers that Redis lost
// come back without a restart of the role.

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as PinoLogger;

const tickJob = (name: string): Job =>
  ({
    id: '1',
    name,
    queueName: 'scheduler',
    data: {},
    timestamp: 1_000,
    delay: 500,
    processedOn: 4_000,
  }) as Job;

describe('the scheduler processor', () => {
  it('takes the planned time of a run from the id the job scheduler gives its job', () => {
    // BullMQ sets the delay to 0 when the job becomes due; the id keeps the planned time.
    expect(plannedAtOf({ id: 'repeat:tick.publish:1792386000000', timestamp: 1792385970000, delay: 0 })).toBe(
      1792386000000,
    );
    expect(plannedAtOf({ id: '7', timestamp: 1_000, delay: 500 })).toBe(1_500);
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-19T05:00:00Z'), toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    metricsRegistry.resetMetrics();
  });

  it('creates again the job schedulers of its ticks that Redis lost, and only those', async () => {
    const known = new Set(['tick.publish']);
    const queue = {
      getJobScheduler: vi.fn((id: string) => Promise.resolve(known.has(id) ? { key: id } : undefined)),
      upsertJobScheduler: vi.fn((id: string) => {
        known.add(id);
        return Promise.resolve({});
      }),
    };
    const processor = new SchedulerProcessor(
      queue as unknown as Queue,
      { 'tick.publish': () => Promise.resolve({}), 'tick.sweep-queued': () => Promise.resolve({}) },
      { SCHEDULER_TICK_MS: 15_000 } as WorkerEnv,
      logger,
    );

    await expect(processor.restoreMissing()).resolves.toEqual(['tick.sweep-queued']);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'tick.sweep-queued',
      { every: 60_000 },
      expect.objectContaining({ name: 'tick.sweep-queued' }),
    );
    await expect(processor.restoreMissing()).resolves.toEqual([]);
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('records the lag and the success of one tick and the failure of another', async () => {
    const processor = new SchedulerProcessor(
      {} as Queue,
      {
        'tick.tokens': () => Promise.resolve({ refreshed: 1 }),
        'tick.maintenance': () => Promise.reject(new Error('database down')),
      },
      {} as WorkerEnv,
      logger,
    );

    await processor.process(tickJob('tick.tokens'));
    await expect(processor.process(tickJob('tick.maintenance'))).rejects.toThrow('database down');

    const text = await metricsRegistry.metrics();
    expect(text).toContain('smp_scheduler_tick_lag_seconds{tick="tick.tokens"} 2.5');
    expect(text).toContain(
      'smp_scheduler_tick_last_success_timestamp_seconds{tick="tick.tokens"} 1792386000',
    );
    expect(text).toContain(
      'smp_scheduler_tick_last_failure_timestamp_seconds{tick="tick.maintenance"} 1792386000',
    );
    expect(text).not.toContain('smp_scheduler_tick_last_success_timestamp_seconds{tick="tick.maintenance"}');
    expect(text).toContain('smp_worker_jobs_total{queue="scheduler",status="failed"} 1');
  });
});
