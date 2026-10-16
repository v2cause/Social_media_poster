import type { AiEffort, AiFailureCode } from '@smp/core';
import type { Platform } from '@smp/platform-rules';

import type { VariantCheck } from './checks';
import type { GoldenCase } from './suite';

// The report of an eval run (guide step 2.10), stored as JSON next to its Markdown rendering.

export type CaseOutcome = 'completed' | AiFailureCode | 'skipped_budget' | 'dry_run';

export interface CaseResult {
  id: string;
  language: GoldenCase['language'];
  styleKey: string;
  outcome: CaseOutcome;
  estimateMicros: number;
  costMicros: number;
  modelServed: string | null;
  /** More than one attempt means a server-side fallback answered. */
  attempts: number;
  latencyMs: number | null;
  ttftMs: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  variants: VariantCheck[];
}

export interface EvalReport {
  version: 1;
  startedAt: string;
  finishedAt: string;
  provider: string;
  promptVersion: string;
  model: string;
  effort: AiEffort;
  dryRun: boolean;
  budgetMicros: number;
  spentMicros: number;
  budgetExhausted: boolean;
  suiteVersion: number;
  cases: CaseResult[];
  summary: EvalSummary;
}

/** Rates are shares between 0 and 1, or null when nothing was measured. */
export interface EvalSummary {
  generations: { total: number; completed: number; refused: number; failed: number; skipped: number };
  failures: Partial<Record<AiFailureCode, number>>;
  refusalRate: number | null;
  variants: number;
  schemaValidRate: number | null;
  withinLimitRate: number | null;
  issueFreeRate: number | null;
  forbiddenFreeRate: number | null;
  languageCorrectRate: number | null;
  costMicros: { total: number; perGeneration: number | null; estimatePerGeneration: number | null };
  latencyMs: { p50: number | null; p95: number | null };
  ttftMs: { p50: number | null };
  tokensPerGeneration: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  byPlatform: Partial<
    Record<
      Platform,
      { variants: number; withinLimitRate: number | null; averageLength: number | null; maxLength: number }
    >
  >;
}
