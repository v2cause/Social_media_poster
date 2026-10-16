import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { tokenRefreshJobId } from './job-id';

// Queue "tokens", job "token.refresh" (architecture 7.4, guide step 4.9), processed by the worker
// role "publisher": renews the tokens of a connection under the lock of the connection.

export const TOKENS_QUEUE = 'tokens';
export const TOKEN_REFRESH = 'token.refresh';

export const tokenRefreshSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  connectionId: z.uuid(),
});
export type TokenRefresh = z.output<typeof tokenRefreshSchema>;

const DAY_SECONDS = 24 * 60 * 60;

export const TOKEN_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

export const parseTokenRefresh = (data: unknown): TokenRefresh => tokenRefreshSchema.parse(data);

export class TokenProducer {
  constructor(private readonly queue: Queue) {}

  /** One waiting refresh per connection; a second request while it waits changes nothing. */
  async refresh(job: TokenRefresh): Promise<void> {
    const payload = tokenRefreshSchema.parse(job);
    await this.queue.add(TOKEN_REFRESH, payload, {
      ...TOKEN_JOB_OPTIONS,
      jobId: tokenRefreshJobId(payload.connectionId),
    });
  }
}
