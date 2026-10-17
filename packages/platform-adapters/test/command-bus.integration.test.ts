import { randomUUID } from 'node:crypto';

import { startRedis, type StartedRedis } from '@smp/testing';
import { XB_COMMANDS_QUEUE, type XbCommand } from '@smp/x-browser';
import { Queue, QueueEvents, UnrecoverableError, Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BullXbCommandBus, CommandNotAnsweredError } from '../src';

// Guide step 6.3 on Redis: a command goes to xb-commands as one attempt with the id of the
// command, and its outcome comes back as the return value of the job. A job that fails, a wait
// that runs out and a caller that stops each end without an outcome.

const command = (): XbCommand<'verify-session'> => ({
  commandId: randomUUID(),
  deadline: '2026-10-17T08:02:00.000Z',
  target: {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    accountId: randomUUID(),
    externalUserId: '1234567890',
    handle: 'smp_demo',
    locale: 'de',
    session: Buffer.from('sealed').toString('base64'),
  },
});
const user = { id: '1234567890', handle: 'smp_demo', name: 'SMP Demo', avatarUrl: null };

describe('BullXbCommandBus', () => {
  let started: StartedRedis | undefined;
  let queue: Queue | undefined;
  let events: QueueEvents | undefined;
  let worker: Worker | undefined;
  const seen: Job<XbCommand<'verify-session'>>[] = [];
  const behavior = new Map<string, 'answer' | 'fail' | 'hang'>();

  beforeAll(async () => {
    started = await startRedis();
    const connection = { url: started.url };
    queue = new Queue(XB_COMMANDS_QUEUE, { connection });
    events = new QueueEvents(XB_COMMANDS_QUEUE, { connection });
    worker = new Worker(
      XB_COMMANDS_QUEUE,
      async (job: Job<XbCommand<'verify-session'>>) => {
        seen.push(job);
        switch (behavior.get(job.data.commandId)) {
          case 'fail':
            throw new UnrecoverableError('The command does not parse.');
          case 'hang':
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            return { ok: true, data: { user } };
          default:
            return { ok: true, data: { user } };
        }
      },
      { connection: { ...connection, maxRetriesPerRequest: null }, concurrency: 4 },
    );
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await events?.close();
    await queue?.close();
    await started?.stop();
  });

  const bus = () => new BullXbCommandBus(queue as Queue, events as QueueEvents);
  const options = (overrides: Partial<{ waitMs: number; signal: AbortSignal }> = {}) => ({
    waitMs: overrides.waitMs ?? 10_000,
    signal: overrides.signal ?? new AbortController().signal,
    heartbeat: () => Promise.resolve(),
  });

  it('returns the outcome of the job, sent once under the id of the command', async () => {
    const sent = command();
    await expect(bus().send('verify-session', sent, options())).resolves.toEqual({
      ok: true,
      data: { user },
    });
    const job = seen.find((candidate) => candidate.data.commandId === sent.commandId);
    expect(job?.name).toBe('xb.verify-session');
    expect(job?.id).toBe(`xb.verify-session.${sent.commandId}`);
    expect(job?.opts.attempts).toBe(1);
  });

  it('ends without an outcome when the job fails, the wait runs out or the caller stops', async () => {
    const failing = command();
    behavior.set(failing.commandId, 'fail');
    await expect(bus().send('verify-session', failing, options())).rejects.toEqual(
      new CommandNotAnsweredError('failed'),
    );

    const slow = command();
    behavior.set(slow.commandId, 'hang');
    await expect(bus().send('verify-session', slow, options({ waitMs: 500 }))).rejects.toEqual(
      new CommandNotAnsweredError('timeout'),
    );

    const stopped = command();
    behavior.set(stopped.commandId, 'hang');
    const controller = new AbortController();
    const pending = bus().send('verify-session', stopped, options({ signal: controller.signal }));
    setTimeout(() => {
      controller.abort();
    }, 200);
    await expect(pending).rejects.toEqual(new CommandNotAnsweredError('aborted'));
  });
});
