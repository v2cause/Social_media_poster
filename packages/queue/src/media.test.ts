import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { MEDIA_JOB_OPTIONS, MEDIA_PROCESS, MediaProducer, parseMediaProcess } from './media';

const job = { organizationId: randomUUID(), workspaceId: randomUUID(), assetId: randomUUID() };

describe('media queue', () => {
  it('adds one media.process job per asset, with retries', async () => {
    const add = vi.fn().mockResolvedValue(undefined);

    await new MediaProducer({ add } as unknown as Queue).process(job);

    expect(add).toHaveBeenCalledWith(MEDIA_PROCESS, job, {
      ...MEDIA_JOB_OPTIONS,
      jobId: `media.${job.assetId}`,
    });
    // BullMQ refuses custom job ids with a colon (architecture 7.4).
    expect(`media.${job.assetId}`).not.toContain(':');
    expect(MEDIA_JOB_OPTIONS).toMatchObject({ attempts: 5, removeOnComplete: true });
  });

  it('refuses payloads that are not ids, when added and when processed', async () => {
    const add = vi.fn();

    await expect(
      new MediaProducer({ add } as unknown as Queue).process({ ...job, assetId: '../other' }),
    ).rejects.toThrow();

    expect(add).not.toHaveBeenCalled();
    expect(parseMediaProcess(job)).toEqual(job);
    expect(() => parseMediaProcess({ assetId: job.assetId })).toThrow();
  });
});
