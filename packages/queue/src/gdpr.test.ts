import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  GDPR_ERASE,
  GDPR_EXPORT,
  GDPR_JOB_OPTIONS,
  GDPR_SWEEP,
  GDPR_SWEEP_JOB_OPTIONS,
  GdprProducer,
  parseGdprJob,
  parseGdprSweep,
} from './gdpr';

describe('gdpr queue', () => {
  it('adds one job per request, keyed by the request', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const producer = new GdprProducer({ add } as unknown as Queue);
    const requestId = randomUUID();

    await producer.exportData({ requestId });
    await producer.erase({ requestId });

    expect(add).toHaveBeenNthCalledWith(
      1,
      GDPR_EXPORT,
      { requestId },
      { ...GDPR_JOB_OPTIONS, jobId: `gdpr.${requestId}` },
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      GDPR_ERASE,
      { requestId },
      { ...GDPR_JOB_OPTIONS, jobId: `gdpr.${requestId}` },
    );
    expect(GDPR_JOB_OPTIONS.attempts).toBe(5);
  });

  it('keeps one sweep at a time and frees its id when it ends', async () => {
    const add = vi.fn().mockResolvedValue(undefined);

    await new GdprProducer({ add } as unknown as Queue).sweep();

    expect(add).toHaveBeenCalledWith(GDPR_SWEEP, {}, { ...GDPR_SWEEP_JOB_OPTIONS, jobId: 'gdpr.sweep' });
    expect(GDPR_SWEEP_JOB_OPTIONS).toMatchObject({ attempts: 1, removeOnComplete: true, removeOnFail: true });
  });

  it('refuses payloads that are not a request id or carry more than the sweep', async () => {
    const add = vi.fn();
    const producer = new GdprProducer({ add } as unknown as Queue);

    await expect(producer.exportData({ requestId: 'not-a-uuid' })).rejects.toThrow();
    expect(() => parseGdprJob({ requestId: randomUUID(), extra: 1 })).not.toThrow();
    expect(() => parseGdprJob({})).toThrow();
    expect(() => {
      parseGdprSweep({ organizationId: randomUUID() });
    }).toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
