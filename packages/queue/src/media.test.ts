import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import {
  MEDIA_DROP_UPLOAD,
  MEDIA_JOB_OPTIONS,
  MEDIA_PROCESS,
  MEDIA_RENDER,
  MediaProducer,
  parseMediaProcess,
  parseMediaRender,
} from './media';

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

  it('adds one media.render job per asset, profile and crop', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const render = {
      ...job,
      postMediaId: randomUUID(),
      profile: 'instagram_feed' as const,
      cropHash: 'x0y250w3000h3750',
    };

    await new MediaProducer({ add } as unknown as Queue).render(render);

    expect(add).toHaveBeenCalledWith(MEDIA_RENDER, render, {
      ...MEDIA_JOB_OPTIONS,
      jobId: `rend.${job.assetId}.instagram_feed.x0y250w3000h3750`,
    });
    expect(parseMediaRender(render)).toEqual(render);
    expect(() => parseMediaRender({ ...render, profile: 'tiktok' })).toThrow();
    expect(() => parseMediaRender({ ...render, cropHash: '../x' })).toThrow();
  });

  it('adds one delayed media.drop-upload job per upload ticket', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const producer = new MediaProducer({ add } as unknown as Queue);

    await producer.dropUpload(job, 3900);

    expect(add).toHaveBeenCalledWith(MEDIA_DROP_UPLOAD, job, {
      ...MEDIA_JOB_OPTIONS,
      jobId: `drop.${job.assetId}`,
      delay: 3_900_000,
    });
    await expect(producer.dropUpload({ ...job, assetId: '../other' }, 3900)).rejects.toThrow();
    await expect(producer.dropUpload(job, -1)).rejects.toThrow();
    expect(add).toHaveBeenCalledTimes(1);
  });
});
