import type { PublishJobInput, PublishJobOutcome } from '@smp/core';
import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { PublishRetryError } from '../publisher/publish-backoff';
import { PublishProcessor } from './publish.processor';

// Guide step 4.8: the outcomes of the publish job in the terms of BullMQ. A rate limit and a
// live lease move the job to later without an attempt, an error that may pass goes to the
// backoff, a final failure is unrecoverable, everything else completes the job.

const NOW = Date.parse('2026-10-16T12:00:00Z');
const payload = {
  organizationId: '0199f0a0-0000-7000-8000-000000000001',
  workspaceId: '0199f0a0-0000-7000-8000-000000000002',
  variantId: '0199f0a0-0000-7000-8000-000000000003',
  scheduleVersion: 3,
  trigger: 'schedule',
};

const setup = (outcome: PublishJobOutcome, job: Partial<{ attemptsMade: number; data: unknown }> = {}) => {
  const inputs: PublishJobInput[] = [];
  const delays: { timestamp: number; token: string | undefined }[] = [];
  const fake = {
    id: 'pub.0199f0a0-0000-7000-8000-000000000003.3',
    name: 'publish.variant',
    data: job.data ?? payload,
    attemptsMade: job.attemptsMade ?? 0,
    opts: { attempts: 6 },
    moveToDelayed: (timestamp: number, token?: string) => {
      delays.push({ timestamp, token });
      return Promise.resolve();
    },
  };
  const processor = new PublishProcessor(
    {
      execute: (input) => {
        inputs.push(input);
        return Promise.resolve(outcome);
      },
    },
    { info: () => undefined, warn: () => undefined },
    () => NOW,
  );
  const run = () => processor.process(fake as unknown as Job, 'worker-a:7', new AbortController().signal);
  return { run, inputs, delays };
};

describe('PublishProcessor', () => {
  it('runs the job with the lock token as lease owner and knows its last attempt', async () => {
    const first = setup({ kind: 'published', reconciled: false, dryRun: false });
    await expect(first.run()).resolves.toBe('published');
    expect(first.inputs[0]).toMatchObject({ ...payload, owner: 'worker-a:7', lastAttempt: false });

    const last = setup({ kind: 'published', reconciled: true, dryRun: false }, { attemptsMade: 5 });
    await expect(last.run()).resolves.toBe('reconciled');
    expect(last.inputs[0]?.lastAttempt).toBe(true);
  });

  it('moves the job to later without an attempt for a live lease and a rate limit', async () => {
    const busy = setup({ kind: 'busy', retryInMs: 61_000 });
    await expect(busy.run()).rejects.toBeInstanceOf(DelayedError);
    expect(busy.delays).toEqual([{ timestamp: NOW + 61_000, token: 'worker-a:7' }]);

    const limited = setup({
      kind: 'retry',
      code: 'RATE_LIMITED',
      retryAfterMs: 2_000,
      countsAsAttempt: false,
    });
    await expect(limited.run()).rejects.toBeInstanceOf(DelayedError);
    expect(limited.delays).toEqual([{ timestamp: NOW + 2_000, token: 'worker-a:7' }]);
  });

  it('hands an error that may pass to the backoff, with the wait the platform asked for', async () => {
    const { run, delays } = setup({
      kind: 'retry',
      code: 'TRANSIENT',
      retryAfterMs: 30_000,
      countsAsAttempt: true,
    });

    const error = await run().catch((failed: unknown) => failed);

    expect(error).toBeInstanceOf(PublishRetryError);
    expect(error).toMatchObject({ code: 'TRANSIENT', retryAfterMs: 30_000 });
    expect(delays).toEqual([]);
  });

  it('ends the job for good on a final failure', async () => {
    const { run } = setup({ kind: 'failed', code: 'VALIDATION_REJECTED' });

    const error = await run().catch((failed: unknown) => failed);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('VALIDATION_REJECTED');
  });

  it('completes the job when it has nothing more to do', async () => {
    await expect(setup({ kind: 'skipped', reason: 'STALE' }).run()).resolves.toBe('skipped:STALE');
    await expect(setup({ kind: 'published', reconciled: false, dryRun: true }).run()).resolves.toBe(
      'dry_run',
    );
    await expect(setup({ kind: 'needs_attention', code: 'OUTCOME_UNKNOWN' }).run()).resolves.toBe(
      'needs_attention:OUTCOME_UNKNOWN',
    );
  });

  it('refuses a payload that does not parse', async () => {
    const { run, inputs } = setup(
      { kind: 'published', reconciled: false, dryRun: false },
      { data: { ...payload, variantId: 'not-a-uuid' } },
    );

    await expect(run()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(inputs).toEqual([]);
  });
});
