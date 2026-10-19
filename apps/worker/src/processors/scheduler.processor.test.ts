import type { Job, Queue } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { metricsRegistry } from '../metrics';
import type { WorkerEnv } from '../worker-env';
import { SchedulerProcessor } from './scheduler.processor';

// Guide step 8.7: every tick reports how late it started and when it last ended with a success
// or a failure, so that an alert sees a tick whose last run failed.

const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as PinoLogger;

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
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-19T05:00:00Z'), toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    metricsRegistry.resetMetrics();
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
