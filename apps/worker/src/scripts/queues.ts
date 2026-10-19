import { createLogger, observabilityEnvSchema } from '@smp/observability';
import { z } from 'zod';

import { QueueInspection } from '../infrastructure/queue-inspection';
import { ALL_QUEUES } from '../queue-names';
import { QUEUES_USAGE, queuesCommandOf } from './queues-args';

// `node dist/scripts/queues.js <command>` in the image of the worker (locally after `pnpm build`:
// pnpm queues <command>): the queues of BullMQ for the operators (guide step 8.7,
// docs/runbooks/haengende-queue.md). One JSON line per queue or job on stdout: counts, ids,
// reasons and attempts, never the data of a job. Removing dead letters is logged.

const envSchema = observabilityEnvSchema
  .pick({ NODE_ENV: true, LOG_LEVEL: true })
  .extend({ REDIS_URL: z.string().min(1) });

const print = (rows: readonly unknown[]): void => {
  for (const row of rows) {
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
};

async function main(): Promise<void> {
  const env = envSchema.parse(process.env);
  const command = queuesCommandOf(process.argv.slice(2));
  if (!command) {
    process.stderr.write(`${QUEUES_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const inspection = new QueueInspection(env.REDIS_URL);
  try {
    switch (command.command) {
      case 'counts':
        print(await inspection.counts(ALL_QUEUES));
        break;
      case 'dead-letters':
        print(await inspection.deadLetters(command.limit));
        break;
      case 'failed':
        print(await inspection.failed(command.queue, command.limit));
        break;
      case 'remove-dead-letters': {
        const removed = await inspection.removeDeadLetters(command.before);
        createLogger({ service: 'worker', environment: env.NODE_ENV, level: env.LOG_LEVEL }).warn(
          { removed, before: command.before?.toISOString() ?? null },
          'queues.dead_letters_removed',
        );
        break;
      }
    }
  } finally {
    await inspection.close();
  }
}

void main();
