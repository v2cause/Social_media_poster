import type { AiCallReport, AiEffort } from '../domain/types';

export const AI_TASKS = ['GENERATE', 'REFINE', 'IDEAS', 'ALT_TEXT', 'VOICE_TEST'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_OUTCOMES = [
  'OK',
  'REFUSED',
  'TRUNCATED',
  'INVALID_OUTPUT',
  'PROVIDER_ERROR',
  'CANCELED',
] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

/** One AI call as AiGeneration stores it (architecture 5.3), written once at its end. */
export interface AiGenerationEntry {
  id: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  task: AiTask;
  postId: string | null;
  brandVoiceVersionId: string | null;
  /** The provider's report; null when the call never started, for example after an early abort. */
  report: AiCallReport | null;
  /** The provider, prompt version and model when there is no report. */
  provider: string;
  promptVersion: string;
  modelRequested: string;
  effort: AiEffort;
  /** What the call was about, without the rendered prompt: brief, style, targets, language, action. */
  input: Record<string, unknown>;
  output: unknown;
  outcome: AiOutcome;
  costMicros: bigint;
}

/** Writes AiGeneration entries (append-only). Implemented in @smp/db. */
export interface AiGenerationLog {
  record(entry: AiGenerationEntry): Promise<void>;
}
