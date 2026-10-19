import { PUBLISH_DEAD_LETTER_QUEUE, publishDeadLetterSchema } from '@smp/queue';
import { type Job, Queue } from 'bullmq';

// What scripts/queues.ts reads and removes in Redis (guide step 8.7): the counts of every queue,
// the copies of the publish jobs that failed for good, and the failed jobs of a queue. A job shows
// its id, name, reason and attempts, never its data; a dead letter holds ids only.

const STATES = ['waiting', 'active', 'delayed', 'prioritized', 'paused', 'failed', 'completed'] as const;
const PAGE = 500;

const isoOf = (millis: number | undefined): string | null =>
  millis === undefined ? null : new Date(millis).toISOString();

export class QueueInspection {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly redisUrl: string) {}

  async counts(names: readonly string[]): Promise<Record<string, unknown>[]> {
    return Promise.all(
      names.map(async (name) => ({ queue: name, ...(await this.queue(name).getJobCounts(...STATES)) })),
    );
  }

  async deadLetters(limit: number): Promise<Record<string, unknown>[]> {
    const jobs = await this.queue(PUBLISH_DEAD_LETTER_QUEUE).getJobs(['waiting'], 0, limit - 1);
    return jobs.map((job) => {
      const letter = publishDeadLetterSchema.safeParse(job.data);
      return letter.success ? { id: job.id, ...letter.data } : { id: job.id, invalid: true };
    });
  }

  /** Removes the dead letters, with a time only those that failed before it; returns how many. */
  async removeDeadLetters(before?: Date): Promise<number> {
    const queue = this.queue(PUBLISH_DEAD_LETTER_QUEUE);
    const doomed: Job[] = [];
    for (let start = 0; ; start += PAGE) {
      const page = await queue.getJobs(['waiting'], start, start + PAGE - 1);
      doomed.push(...page.filter((job) => before === undefined || failedBefore(job, before)));
      if (page.length < PAGE) {
        break;
      }
    }
    for (const job of doomed) {
      await job.remove();
    }
    return doomed.length;
  }

  async failed(name: string, limit: number): Promise<Record<string, unknown>[]> {
    const jobs = await this.queue(name).getFailed(0, limit - 1);
    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      failedReason: job.failedReason.slice(0, 500),
      attemptsMade: job.attemptsMade,
      finishedAt: isoOf(job.finishedOn),
    }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: { url: this.redisUrl } });
      this.queues.set(name, queue);
    }
    return queue;
  }
}

function failedBefore(job: Job, before: Date): boolean {
  const letter = publishDeadLetterSchema.safeParse(job.data);
  return letter.success && Date.parse(letter.data.failedAt) < before.getTime();
}
