import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

import { xbJobId } from './job-id';

// Queues "xb-commands" and "xb-results" (architecture 4.3 and 7.4) between the publisher and the
// browser worker of X (phase 6). The browser worker has no database, so its commands carry what
// it needs: the sealed session (opened only there), the text and signed media URLs. Its answers
// come back as "xb.result" and are processed by the role "publisher".

export const XB_COMMANDS_QUEUE = 'xb-commands';
export const XB_RESULTS_QUEUE = 'xb-results';
export const XB_RESULT = 'xb.result';

export const XB_OPERATIONS = [
  'publish',
  'metrics',
  'verify-session',
  'delete',
  'login.start',
  'canary',
] as const;
export type XbOperation = (typeof XB_OPERATIONS)[number];

/** The job name of a command, for example xb.publish. */
export const xbCommandName = (operation: XbOperation): string => `xb.${operation}`;

// A sealed envelope (packages/crypto) as base64.
const sealed = z.base64().max(200_000);

const target = z.object({
  workspaceId: z.uuid(),
  accountId: z.uuid(),
  session: sealed,
});

export const xbCommandSchemas = {
  publish: target.extend({
    variantId: z.uuid(),
    scheduleVersion: z.number().int().nonnegative(),
    text: z.string().max(25_000),
    media: z.array(z.object({ url: z.url(), altText: z.string().max(1_000).nullable() })).max(4),
  }),
  metrics: target.extend({ externalPostIds: z.array(z.string().min(1).max(64)).min(1).max(100) }),
  'verify-session': target,
  delete: target.extend({ variantId: z.uuid(), externalPostId: z.string().min(1).max(64) }),
  // The credentials the user entered once, sealed with the session keyring.
  'login.start': z.object({ workspaceId: z.uuid(), connectionId: z.uuid(), credentials: sealed }),
  canary: z.object({}),
} as const satisfies Record<XbOperation, z.ZodType>;

export type XbCommand<O extends XbOperation> = z.output<(typeof xbCommandSchemas)[O]>;

export const xbResultSchema = z.object({
  operation: z.enum(XB_OPERATIONS),
  workspaceId: z.uuid().optional(),
  // The variant, account or connection the command was about.
  targetId: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  ok: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  // A code of the error taxonomy (architecture 4.1), for example CHALLENGE_REQUIRED.
  error: z.object({ code: z.string().max(64), message: z.string().max(500) }).optional(),
});
export type XbResult = z.output<typeof xbResultSchema>;

const DAY_SECONDS = 24 * 60 * 60;

/** No automatic retries: a browser session must not be pushed against a challenge (architecture 4.3). */
export const XB_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

export const parseXbCommand = <O extends XbOperation>(operation: O, data: unknown): XbCommand<O> =>
  xbCommandSchemas[operation].parse(data) as XbCommand<O>;
export const parseXbResult = (data: unknown): XbResult => xbResultSchema.parse(data);

export class XbCommandProducer {
  constructor(private readonly queue: Queue) {}

  /** One command per operation, target and version; the version is the caller's, for example the schedule version. */
  async send<O extends XbOperation>(
    operation: O,
    command: XbCommand<O>,
    ref: { targetId: string; version: number },
  ): Promise<void> {
    const payload = xbCommandSchemas[operation].parse(command);
    await this.queue.add(xbCommandName(operation), payload, {
      ...XB_JOB_OPTIONS,
      jobId: xbJobId(operation, ref.targetId, ref.version),
    });
  }
}

export class XbResultProducer {
  constructor(private readonly queue: Queue) {}

  async report(result: XbResult): Promise<void> {
    await this.queue.add(XB_RESULT, xbResultSchema.parse(result), XB_JOB_OPTIONS);
  }
}
