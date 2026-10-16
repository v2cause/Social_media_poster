import { resolve } from 'node:path';

import { callCostMicros, estimateCostMicros, type AiProvider, type ModelPrice } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { PromptTokenEstimator } from '../src/estimate';
import { MockAiProvider } from '../src/mock/mock-ai-provider';
import { runEval, type EvalCosts, type EvalOptions } from './runner';
import { loadSuite, type GoldenSuite } from './suite';

const suite = loadSuite(resolve('eval/golden-briefs.json'));

const price: ModelPrice = {
  inputMicrosPerMtok: 5_000_000n,
  outputMicrosPerMtok: 25_000_000n,
  cacheReadMicrosPerMtok: 500_000n,
  cacheWrite5mMicrosPerMtok: 6_250_000n,
  cacheWrite1hMicrosPerMtok: 10_000_000n,
};

const costs: EvalCosts = {
  estimateMicros: (_model, tokens) => Promise.resolve(estimateCostMicros(tokens, price)),
  costOf: (report) => Promise.resolve(callCostMicros(report.attempts, () => price, price)),
};

const options = (overrides: Partial<EvalOptions> = {}): EvalOptions => ({
  provider: new MockAiProvider({ model: 'claude-opus-5-5', chunkDelayMs: 0 }),
  suite,
  model: 'claude-opus-5-5',
  effort: 'medium',
  budgetMicros: 100_000_000,
  costs,
  estimator: new PromptTokenEstimator(),
  dryRun: false,
  now: () => new Date('2026-10-16T12:00:00.000Z'),
  log: () => undefined,
  ...overrides,
});

describe('golden briefs', () => {
  it('cover both languages with the six presets on all four platforms', () => {
    const styles = [
      'professional',
      'storytelling',
      'casual',
      'educational',
      'thought_leadership',
      'promotional',
    ];

    expect(suite.platforms).toEqual(['LINKEDIN', 'INSTAGRAM', 'FACEBOOK', 'X']);
    for (const language of ['de', 'en'] as const) {
      const own = suite.cases.filter((entry) => entry.language === language);
      expect(own.map((entry) => entry.styleKey).sort()).toEqual([...styles].sort());
      expect(suite.brands[language].voice.language).toBe(language);
      expect(suite.brands[language].voice.forbiddenWords.length).toBeGreaterThan(0);
    }
  });
});

describe('runEval', () => {
  it('checks every variant of every case and reports the costs', async () => {
    const report = await runEval(options());

    expect(report.summary.generations).toEqual({
      total: 12,
      completed: 12,
      refused: 0,
      failed: 0,
      skipped: 0,
    });
    expect(report.summary.variants).toBe(48);
    expect(report.summary).toMatchObject({
      schemaValidRate: 1,
      withinLimitRate: 1,
      issueFreeRate: 1,
      forbiddenFreeRate: 1,
      languageCorrectRate: 1,
      refusalRate: 0,
    });
    expect(report.spentMicros).toBeGreaterThan(0);
    expect(report.summary.costMicros.perGeneration).toBe(Math.round(report.spentMicros / 12));
    expect(report).toMatchObject({ provider: 'mock', model: 'claude-opus-5-5', dryRun: false });
  });

  it('records refusals and failures per case', async () => {
    const refusing: GoldenSuite = {
      ...suite,
      cases: suite.cases
        .slice(0, 2)
        .map((entry, index) => (index === 0 ? { ...entry, brief: `${entry.brief} [mock:refusal]` } : entry)),
    };

    const report = await runEval(options({ suite: refusing }));

    expect(report.cases.map((entry) => entry.outcome)).toEqual(['REFUSED', 'completed']);
    expect(report.summary.refusalRate).toBe(0.5);
    expect(report.summary.failures).toEqual({ REFUSED: 1 });
  });

  it('skips the remaining cases once the next estimate would exceed the budget', async () => {
    // Every call is estimated at 100 and costs 80: after two calls 160 are spent, and a third
    // estimate would reach 260.
    const fixed: EvalCosts = {
      estimateMicros: () => Promise.resolve(100n),
      costOf: () => Promise.resolve({ costMicros: 80n, unpricedModels: [] }),
    };

    const report = await runEval(options({ costs: fixed, budgetMicros: 250 }));

    expect(report.cases.map((entry) => entry.outcome)).toEqual([
      'completed',
      'completed',
      ...Array.from({ length: 10 }, () => 'skipped_budget'),
    ]);
    expect(report.budgetExhausted).toBe(true);
    expect(report.spentMicros).toBe(160);
    expect(report.summary.generations.skipped).toBe(10);
  });

  it('only estimates on a dry run', async () => {
    const provider: AiProvider = {
      name: 'never',
      promptVersion: 'gen-v1',
      generateVariants: () => {
        throw new Error('no call on a dry run');
      },
      refineVariant: () => {
        throw new Error('unused');
      },
      suggestTopics: () => Promise.reject(new Error('unused')),
      suggestAltText: () => Promise.reject(new Error('unused')),
    };

    const report = await runEval(options({ provider, dryRun: true }));

    expect(report.cases.every((entry) => entry.outcome === 'dry_run')).toBe(true);
    expect(report.spentMicros).toBe(report.cases.reduce((sum, entry) => sum + entry.estimateMicros, 0));
    expect(report.summary.costMicros.estimatePerGeneration).toBeGreaterThan(0);
    expect(report.summary.generations.skipped).toBe(12);
  });
});
