import {
  parseXbOutcome,
  xbCommandName,
  type XbCommand,
  type XbOperation,
  type XbOutcome,
} from '@smp/x-browser';
import type { Queue, QueueEvents } from 'bullmq';

// The way of the commands to the browser worker (guide step 6.3): a job on xb-commands whose
// return value is the outcome. The caller waits for it, keeps its lease alive meanwhile and gives
// up at its deadline; a command that no longer reaches the browser worker in time expires there.

export interface SendOptions {
  /** How long to wait for the outcome. */
  waitMs: number;
  signal: AbortSignal;
  /** Called every minute while waiting, for example to extend the lease of a publish job. */
  heartbeat: () => Promise<void>;
}

/** Why no outcome came: the wait ran out, the job failed (for example it stalled), or the caller stopped. */
export class CommandNotAnsweredError extends Error {
  constructor(readonly reason: 'timeout' | 'failed' | 'aborted') {
    super(`The browser worker gave no outcome: ${reason}.`);
    this.name = 'CommandNotAnsweredError';
  }
}

export interface XbCommandBus {
  send<O extends XbOperation>(
    operation: O,
    command: XbCommand<O>,
    options: SendOptions,
  ): Promise<XbOutcome<O>>;
}

const HEARTBEAT_MS = 60_000;

export class BullXbCommandBus implements XbCommandBus {
  constructor(
    private readonly queue: Queue,
    private readonly events: QueueEvents,
  ) {}

  async send<O extends XbOperation>(
    operation: O,
    command: XbCommand<O>,
    options: SendOptions,
  ): Promise<XbOutcome<O>> {
    if (options.signal.aborted) {
      throw new CommandNotAnsweredError('aborted');
    }
    const job = await this.queue.add(xbCommandName(operation), command, {
      jobId: `xb.${operation}.${command.commandId}`,
      // A command never runs twice: an unclear one is reconciled by its caller.
      attempts: 1,
      removeOnComplete: { age: 3_600 },
      removeOnFail: { age: 86_400 },
    });
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(new CommandNotAnsweredError('aborted'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      timer = setInterval(() => {
        options.heartbeat().catch((error: unknown) => {
          reject(error instanceof Error ? error : new Error('The heartbeat failed.'));
        });
      }, HEARTBEAT_MS);
    });
    const finished = job.waitUntilFinished(this.events, options.waitMs).catch((error: unknown) => {
      const timedOut = error instanceof Error && /timed out/i.test(error.message);
      throw new CommandNotAnsweredError(timedOut ? 'timeout' : 'failed');
    });
    // After an abort nobody waits for the outcome any more; its failure is no longer news.
    finished.catch(() => undefined);
    try {
      const value: unknown = await Promise.race([finished, stopped]);
      return parseXbOutcome(operation, value);
    } finally {
      clearInterval(timer);
      if (onAbort) {
        options.signal.removeEventListener('abort', onAbort);
      }
    }
  }
}
