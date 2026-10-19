import { describe, expect, it } from 'vitest';

import { jobLogContext, runInJobContext } from './job-context';
import { currentLogContext, runWithLogContext } from './log-context';

const ORG = '0194f1b2-7c3a-7d4e-9f10-2a3b4c5d6e7f';
const WORKSPACE = '0194f1b2-7c3a-7d4e-9f10-3a3b4c5d6e7f';

const job = (id: string, data: unknown) => ({ id, name: 'publish.variant', queueName: 'publish', data });

describe('jobLogContext', () => {
  it('takes ID, queue and name of the job and the tenant of its payload', () => {
    expect(jobLogContext(job('7', { organizationId: ORG, workspaceId: WORKSPACE, variantId: ORG }))).toEqual({
      jobId: '7',
      queue: 'publish',
      job: 'publish.variant',
      organizationId: ORG,
      workspaceId: WORKSPACE,
    });
  });

  it('leaves out the rest of the payload and tenant fields that are no UUID', () => {
    expect(
      jobLogContext(job('8', { organizationId: 'org-1', workspaceId: 42, email: 'ada@example.test' })),
    ).toEqual({ jobId: '8', queue: 'publish', job: 'publish.variant' });
    expect(
      jobLogContext({ id: undefined, name: 'tick.publish', queueName: 'scheduler', data: null }),
    ).toEqual({
      queue: 'scheduler',
      job: 'tick.publish',
    });
  });
});

describe('runInJobContext', () => {
  it('sets the context for the work only and keeps the fields of an outer context', () => {
    const inner = runWithLogContext({ requestId: 'r-1' }, () =>
      runInJobContext(job('9', { workspaceId: WORKSPACE }), () => currentLogContext()),
    );

    expect(inner).toEqual({
      requestId: 'r-1',
      jobId: '9',
      queue: 'publish',
      job: 'publish.variant',
      workspaceId: WORKSPACE,
    });
    expect(currentLogContext()).toEqual({});
  });
});
