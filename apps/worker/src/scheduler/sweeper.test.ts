import { randomUUID } from 'node:crypto';

import type { StaleVariant } from '@smp/db';
import { publishJobId, type PublishVariant } from '@smp/queue';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { Sweeper } from './sweeper';

// Guide step 4.7: the sweeper adds a missing job again and restarts one that failed or completed
// under the same id; a job still on its way is left alone.

const stale = (status: StaleVariant['status']): StaleVariant => ({
  variantId: randomUUID(),
  workspaceId: randomUUID(),
  organizationId: randomUUID(),
  scheduleVersion: 3,
  status,
});

describe('Sweeper', () => {
  it('adds, restarts or leaves the job of each stale variant', async () => {
    const variants = [
      stale('QUEUED'),
      stale('PUBLISHING'),
      stale('PUBLISHING'),
      stale('RETRYING'),
      stale('QUEUED'),
    ];
    const [missing, failed, completed, delayed, broken] = variants;
    const retried: string[] = [];
    const job = (id: string, state: string): Job =>
      ({
        getState: () => Promise.resolve(state),
        retry: (from: string) => {
          retried.push(`${id}:${from}`);
          return id === publishJobId(broken?.variantId ?? '', 3)
            ? Promise.reject(new Error('Job is not in the failed state'))
            : Promise.resolve();
        },
      }) as unknown as Job;
    const states = new Map([
      [publishJobId(failed?.variantId ?? '', 3), 'failed'],
      [publishJobId(completed?.variantId ?? '', 3), 'completed'],
      [publishJobId(delayed?.variantId ?? '', 3), 'delayed'],
      [publishJobId(broken?.variantId ?? '', 3), 'failed'],
    ]);
    const added: PublishVariant[] = [];

    const result = await new Sweeper({
      plans: { stale: () => Promise.resolve(variants) },
      queue: {
        getJob: (id: string) => {
          const state = states.get(id);
          return Promise.resolve(state ? job(id, state) : undefined);
        },
      },
      producer: {
        publish: (payload) => {
          added.push(payload);
          return Promise.resolve();
        },
      },
    }).run();

    expect(result).toEqual({ checked: 5, added: 1, restarted: 2, running: 1, failed: 1 });
    expect(added).toEqual([
      expect.objectContaining({ variantId: missing?.variantId, scheduleVersion: 3, trigger: 'sweep' }),
    ]);
    expect(retried.map((entry) => entry.split(':').at(-1))).toEqual(['failed', 'completed', 'failed']);
  });
});
