import {
  parseXbCommand,
  xbOperationOf,
  type XbCommand,
  type XbOperation,
  type XbOutcome,
} from '@smp/x-browser';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

import { Postponed, type AccountOperation } from './command-runner';

// The processor of the queue xb-commands (guide step 6.2): the job name picks the operation, zod
// checks the command, and the outcome is the return value of the job, which its caller awaits. A
// command that is busy waits as a delayed job without using an attempt; one that does not parse
// fails at once, nothing is tried again.

export interface CommandHandlers {
  run<O extends AccountOperation>(operation: O, command: XbCommand<O>): Promise<XbOutcome<O>>;
  login(command: XbCommand<'login.start'>): Promise<XbOutcome<'login.start'>>;
}

export async function processCommand(
  job: Pick<Job, 'name' | 'data' | 'moveToDelayed'>,
  token: string | undefined,
  handlers: CommandHandlers,
  now: () => Date,
): Promise<XbOutcome<XbOperation>> {
  const operation = xbOperationOf(job.name);
  if (operation === null) {
    throw new UnrecoverableError(`Unknown command ${job.name.slice(0, 40)}.`);
  }
  let command: XbCommand<XbOperation>;
  try {
    command = parseXbCommand(operation, job.data);
  } catch {
    // The issues would name fields of the payload; the job name is enough.
    throw new UnrecoverableError(`The command ${job.name} does not parse.`);
  }
  if (operation === 'login.start') {
    return handlers.login(command as XbCommand<'login.start'>);
  }
  try {
    return await handlers.run(operation, command as XbCommand<AccountOperation>);
  } catch (error) {
    if (error instanceof Postponed && token !== undefined) {
      await job.moveToDelayed(now().getTime() + error.waitMs, token);
      throw new DelayedError();
    }
    throw error;
  }
}
