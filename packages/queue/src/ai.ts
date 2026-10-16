import type { JobsOptions, Queue } from 'bullmq';
import { z } from 'zod';

// Queue "ai" (architecture 7.4), processed by the worker role "ai": suggestions made in the
// background. On request both run synchronously in the API (ADR 0016 and 0021).

export const AI_QUEUE = 'ai';
export const AI_TOPIC_IDEAS = 'ai.topic-ideas';
export const AI_ALT_TEXT = 'ai.alt-text';

export const aiTopicIdeasSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
});
export type AiTopicIdeas = z.output<typeof aiTopicIdeasSchema>;

export const aiAltTextSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  assetId: z.uuid(),
});
export type AiAltText = z.output<typeof aiAltTextSchema>;

const DAY_SECONDS = 24 * 60 * 60;

export const AI_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: DAY_SECONDS },
};

export const parseAiTopicIdeas = (data: unknown): AiTopicIdeas => aiTopicIdeasSchema.parse(data);
export const parseAiAltText = (data: unknown): AiAltText => aiAltTextSchema.parse(data);

export class AiJobProducer {
  constructor(private readonly queue: Queue) {}

  async topicIdeas(job: AiTopicIdeas): Promise<void> {
    await this.queue.add(AI_TOPIC_IDEAS, aiTopicIdeasSchema.parse(job), AI_JOB_OPTIONS);
  }

  async altText(job: AiAltText): Promise<void> {
    await this.queue.add(AI_ALT_TEXT, aiAltTextSchema.parse(job), AI_JOB_OPTIONS);
  }
}
