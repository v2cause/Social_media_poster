import type {
  AiCallReport,
  AiEffort,
  AiFailureCode,
  AiProvider,
  AiUsageEstimator,
  CallCost,
  GeneratedVariant,
  GenerateVariantsInput,
  TokenEstimate,
} from '@smp/core';

import { checkVariant, type VariantCheck } from './checks';
import { summarize } from './report';
import type { GoldenCase, GoldenSuite } from './suite';
import type { CaseResult, EvalReport } from './types';

// The run of the eval suite (guide step 2.10). Every case is one generation for all platforms,
// as in the composer. Before each call the upper cost estimate is checked against the budget;
// once it would be exceeded, the remaining cases are skipped. A dry run only estimates.

export interface EvalCosts {
  estimateMicros(model: string, tokens: TokenEstimate): Promise<bigint>;
  costOf(report: Pick<AiCallReport, 'modelRequested' | 'attempts'>): Promise<CallCost>;
}

export interface EvalOptions {
  provider: AiProvider;
  suite: GoldenSuite;
  model: string;
  effort: AiEffort;
  budgetMicros: number;
  costs: EvalCosts;
  estimator: AiUsageEstimator;
  dryRun: boolean;
  now: () => Date;
  log: (line: string) => void;
}

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function inputOf(suite: GoldenSuite, entry: GoldenCase): GenerateVariantsInput {
  const brand = suite.brands[entry.language];
  return {
    brand: { profile: brand.profile, voice: brand.voice, customStyles: [] },
    styleKey: entry.styleKey,
    targets: suite.platforms.map((platform, index) => ({ key: `t${String(index + 1)}`, platform })),
    language: entry.language,
    brief: entry.brief,
    mediaDescriptions: [],
  };
}

/** The final event of a generation: the variants, or the failure, with the call report. */
async function generate(
  provider: AiProvider,
  input: GenerateVariantsInput,
  effort: AiEffort,
): Promise<{ variants: GeneratedVariant[] | null; failure: AiFailureCode | null; report: AiCallReport }> {
  for await (const event of provider.generateVariants(input, { effort })) {
    if (event.type === 'completed') {
      return { variants: event.variants, failure: null, report: event.report };
    }
    if (event.type === 'failed') {
      return { variants: null, failure: event.failure.code, report: event.report };
    }
  }
  throw new Error('The provider ended the stream without a result.');
}

/** A target the answer left out fails every check. */
const missing = (target: { key: string; platform: VariantCheck['platform'] }): VariantCheck => ({
  targetKey: target.key,
  platform: target.platform,
  schemaValid: false,
  matchesTarget: false,
  length: 0,
  maxLength: 0,
  withinLimit: false,
  issues: [],
  forbiddenWords: [],
  language: 'unknown',
  languageCorrect: false,
});

export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const { provider, suite } = options;
  const startedAt = options.now();
  const cases: CaseResult[] = [];
  let spent = 0n;
  let exhausted = false;

  for (const entry of suite.cases) {
    const input = inputOf(suite, entry);
    const estimate = await options.costs.estimateMicros(
      options.model,
      options.estimator.estimate({ task: 'generate', input }),
    );
    const base = {
      id: entry.id,
      language: entry.language,
      styleKey: entry.styleKey,
      estimateMicros: Number(estimate),
      costMicros: 0,
      modelServed: null,
      attempts: 0,
      latencyMs: null,
      ttftMs: null,
      tokens: NO_TOKENS,
      variants: [],
    } satisfies Omit<CaseResult, 'outcome'>;

    if (exhausted || spent + estimate > BigInt(options.budgetMicros)) {
      exhausted = true;
      cases.push({ ...base, outcome: 'skipped_budget' });
      options.log(`${entry.id}: skipped, the budget would be exceeded`);
      continue;
    }
    if (options.dryRun) {
      spent += estimate;
      cases.push({ ...base, outcome: 'dry_run' });
      options.log(`${entry.id}: estimated ${String(estimate)} micro-USD`);
      continue;
    }

    const result = await generate(provider, input, options.effort);
    const cost = await options.costs.costOf(result.report);
    spent += cost.costMicros;
    const forbiddenWords = suite.brands[entry.language].voice.forbiddenWords;
    const variants =
      result.variants === null
        ? []
        : input.targets.map((target) => {
            const variant = result.variants?.find((candidate) => candidate.targetKey === target.key);
            return variant
              ? checkVariant(variant, target, { language: entry.language, forbiddenWords })
              : missing(target);
          });
    const { attempts } = result.report;
    cases.push({
      ...base,
      outcome: result.failure ?? 'completed',
      costMicros: Number(cost.costMicros),
      modelServed: result.report.modelServed,
      attempts: attempts.length,
      latencyMs: result.report.latencyMs,
      ttftMs: result.report.ttftMs,
      tokens: {
        input: attempts.reduce((sum, attempt) => sum + attempt.inputTokens, 0),
        output: attempts.reduce((sum, attempt) => sum + attempt.outputTokens, 0),
        cacheRead: attempts.reduce((sum, attempt) => sum + attempt.cacheReadTokens, 0),
        cacheWrite: attempts.reduce(
          (sum, attempt) => sum + attempt.cacheWrite5mTokens + attempt.cacheWrite1hTokens,
          0,
        ),
      },
      variants,
    });
    options.log(`${entry.id}: ${result.failure ?? 'completed'}, ${String(cost.costMicros)} micro-USD`);
  }

  return {
    version: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: options.now().toISOString(),
    provider: provider.name,
    promptVersion: provider.promptVersion,
    model: options.model,
    effort: options.effort,
    dryRun: options.dryRun,
    budgetMicros: options.budgetMicros,
    spentMicros: Number(spent),
    budgetExhausted: exhausted,
    suiteVersion: suite.version,
    cases,
    summary: summarize(cases),
  };
}
