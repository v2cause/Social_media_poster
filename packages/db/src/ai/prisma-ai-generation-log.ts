import type { AiAttempt, AiGenerationEntry, AiGenerationLog } from '@smp/core';

import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { withTenantTx } from '../tenant-context';

// AiGeneration on PostgreSQL (architecture 5.3): written once at the end of a call, append-only
// for app_user. The token sums cover every attempt; the attempts themselves are kept as JSON.

/** A plain JSON copy: drops undefined values and fails on what JSON cannot hold. */
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const sum = (attempts: readonly AiAttempt[], pick: (attempt: AiAttempt) => number): number =>
  attempts.reduce((total, attempt) => total + pick(attempt), 0);

export class PrismaAiGenerationLog implements AiGenerationLog {
  constructor(private readonly base: PrismaClient) {}

  record(entry: AiGenerationEntry): Promise<void> {
    const scope = {
      userId: entry.userId,
      organizationId: entry.organizationId,
      workspaceId: entry.workspaceId,
    };
    const report = entry.report;
    const attempts = report?.attempts ?? [];
    return withTenantTx(this.base, scope, async (tx) => {
      await tx.aiGeneration.create({
        data: {
          id: entry.id,
          workspaceId: entry.workspaceId,
          userId: entry.userId,
          task: entry.task,
          postId: entry.postId,
          brandVoiceVersionId: entry.brandVoiceVersionId,
          promptVersion: report?.promptVersion ?? entry.promptVersion,
          provider: report?.provider ?? entry.provider,
          modelRequested: report?.modelRequested ?? entry.modelRequested,
          modelServed: report?.modelServed ?? null,
          effort: entry.effort,
          input: json(entry.input),
          output: entry.output === null || entry.output === undefined ? Prisma.DbNull : json(entry.output),
          outcome: entry.outcome,
          stopReason: report?.stopReason ?? null,
          refusalCategory: report?.refusalCategory ?? null,
          inputTokens: sum(attempts, (attempt) => attempt.inputTokens),
          outputTokens: sum(attempts, (attempt) => attempt.outputTokens),
          cacheReadTokens: sum(attempts, (attempt) => attempt.cacheReadTokens),
          cacheWriteTokens: sum(
            attempts,
            (attempt) => attempt.cacheWrite5mTokens + attempt.cacheWrite1hTokens,
          ),
          attempts: json(attempts),
          costMicros: entry.costMicros,
          latencyMs: report?.latencyMs ?? null,
          ttftMs: report?.ttftMs ?? null,
        },
      });
    });
  }
}
