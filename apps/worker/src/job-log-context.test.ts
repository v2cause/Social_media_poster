import { Writable } from 'node:stream';

import { createLogger, currentLogContext } from '@smp/observability';
import { describe, expect, it } from 'vitest';

import { hasJobLogContext, JobLogContext } from './job-log-context';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { BillingProcessor } from './processors/billing.processor';
import { GdprProcessor } from './processors/gdpr.processor';
import { MediaProcessor } from './processors/media.processor';
import { NotifyProcessor } from './processors/notify.processor';
import { PublishProcessor } from './processors/publish.processor';
import { SchedulerProcessor } from './processors/scheduler.processor';
import { TokenRefreshProcessor } from './processors/token-refresh.processor';
import { XbResultsProcessor } from './processors/xb-results.processor';

const ORG = '0194f1b2-7c3a-7d4e-9f10-2a3b4c5d6e7f';
const WORKSPACE = '0194f1b2-7c3a-7d4e-9f10-3a3b4c5d6e7f';

type LogLine = Record<string, unknown>;

function captureLogs(): { lines: LogLine[]; destination: Writable } {
  const lines: LogLine[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as LogLine);
      callback();
    },
  });
  return { lines, destination };
}

const job = (id: string, data: unknown) => ({ id, name: 'publish.variant', queueName: 'publish', data });

describe('@JobLogContext()', () => {
  it('gives every line of a job its context, and none outside of it', async () => {
    const { lines, destination } = captureLogs();
    const logger = createLogger({ service: 'worker', environment: 'test', destination });
    class Example {
      @JobLogContext()
      async process(current: ReturnType<typeof job>): Promise<string> {
        await Promise.resolve();
        logger.info('example.step');
        return current.name;
      }
    }

    await expect(
      new Example().process(job('7', { organizationId: ORG, workspaceId: WORKSPACE })),
    ).resolves.toBe('publish.variant');
    logger.info('outside.job');

    expect(lines[0]).toMatchObject({
      msg: 'example.step',
      jobId: '7',
      queue: 'publish',
      job: 'publish.variant',
      organizationId: ORG,
      workspaceId: WORKSPACE,
    });
    expect(lines[1]).not.toHaveProperty('jobId');
    expect(currentLogContext()).toEqual({});
  });

  it('keeps the contexts of jobs that run at the same time apart', async () => {
    class Example {
      @JobLogContext()
      async process(_job: ReturnType<typeof job>, delay: number): Promise<string | undefined> {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return currentLogContext().jobId;
      }
    }
    const example = new Example();

    await expect(
      Promise.all([example.process(job('1', {}), 20), example.process(job('2', {}), 5)]),
    ).resolves.toEqual(['1', '2']);
  });

  it('is on the process method of every processor', () => {
    for (const processor of [
      AnalyticsProcessor,
      BillingProcessor,
      GdprProcessor,
      MediaProcessor,
      NotifyProcessor,
      PublishProcessor,
      SchedulerProcessor,
      TokenRefreshProcessor,
      XbResultsProcessor,
    ]) {
      const method: unknown = Object.getOwnPropertyDescriptor(processor.prototype, 'process')?.value;
      expect(hasJobLogContext(method), processor.name).toBe(true);
    }
  });
});
