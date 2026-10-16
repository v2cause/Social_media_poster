import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AiFailureCode } from '@smp/core';
import { PLATFORMS } from '@smp/platform-rules';

import type { VariantCheck } from './checks';
import type { CaseResult, EvalReport, EvalSummary } from './types';

// Summary, comparison and Markdown of an eval run (guide step 2.10). A report is compared with
// the latest earlier run of the same provider, model and cases in the same directory.

const share = (count: number, total: number): number | null => (total === 0 ? null : count / total);

const rate = (checks: readonly VariantCheck[], passes: (check: VariantCheck) => boolean): number | null =>
  share(checks.filter(passes).length, checks.length);

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

const average = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

export function summarize(cases: readonly CaseResult[]): EvalSummary {
  const ran = cases.filter((entry) => entry.outcome !== 'skipped_budget' && entry.outcome !== 'dry_run');
  const completed = ran.filter((entry) => entry.outcome === 'completed');
  const failures: Partial<Record<AiFailureCode, number>> = {};
  for (const entry of ran) {
    if (entry.outcome !== 'completed') {
      const code = entry.outcome as AiFailureCode;
      failures[code] = (failures[code] ?? 0) + 1;
    }
  }
  const checks = completed.flatMap((entry) => entry.variants);
  const totalCost = ran.reduce((sum, entry) => sum + entry.costMicros, 0);
  const estimated = cases.filter((entry) => entry.outcome !== 'skipped_budget');
  const sumTokens = (field: keyof CaseResult['tokens']): number =>
    Math.round(ran.reduce((sum, entry) => sum + entry.tokens[field], 0) / Math.max(1, ran.length));

  const byPlatform: EvalSummary['byPlatform'] = {};
  for (const platform of PLATFORMS) {
    const own = checks.filter((check) => check.platform === platform);
    if (own.length > 0) {
      byPlatform[platform] = {
        variants: own.length,
        withinLimitRate: rate(own, (check) => check.withinLimit),
        averageLength: average(own.map((check) => check.length)),
        maxLength: Math.max(...own.map((check) => check.maxLength)),
      };
    }
  }

  return {
    generations: {
      total: cases.length,
      completed: completed.length,
      refused: failures.REFUSED ?? 0,
      failed: ran.length - completed.length,
      skipped: cases.length - ran.length,
    },
    failures,
    refusalRate: share(failures.REFUSED ?? 0, ran.length),
    variants: checks.length,
    schemaValidRate: rate(checks, (check) => check.schemaValid && check.matchesTarget),
    withinLimitRate: rate(checks, (check) => check.withinLimit),
    issueFreeRate: rate(checks, (check) => check.issues.length === 0),
    forbiddenFreeRate: rate(checks, (check) => check.forbiddenWords.length === 0),
    languageCorrectRate: rate(checks, (check) => check.languageCorrect),
    costMicros: {
      total: totalCost,
      perGeneration: ran.length === 0 ? null : Math.round(totalCost / ran.length),
      estimatePerGeneration:
        estimated.length === 0
          ? null
          : Math.round(estimated.reduce((sum, entry) => sum + entry.estimateMicros, 0) / estimated.length),
    },
    latencyMs: {
      p50: percentile(
        ran.flatMap((entry) => (entry.latencyMs === null ? [] : [entry.latencyMs])),
        0.5,
      ),
      p95: percentile(
        ran.flatMap((entry) => (entry.latencyMs === null ? [] : [entry.latencyMs])),
        0.95,
      ),
    },
    ttftMs: {
      p50: percentile(
        ran.flatMap((entry) => (entry.ttftMs === null ? [] : [entry.ttftMs])),
        0.5,
      ),
    },
    tokensPerGeneration:
      ran.length === 0
        ? null
        : {
            input: sumTokens('input'),
            output: sumTokens('output'),
            cacheRead: sumTokens('cacheRead'),
            cacheWrite: sumTokens('cacheWrite'),
          },
    byPlatform,
  };
}

// --- Comparison ------------------------------------------------------------------------------

type Metric = {
  label: string;
  value: (summary: EvalSummary) => number | null;
  format: (value: number) => string;
  /** Whether a higher value is better, for the direction of the change. */
  higherIsBetter: boolean;
};

const percent = (value: number): string => `${(value * 100).toFixed(1)} %`;
const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
const ms = (value: number): string => `${String(Math.round(value))} ms`;

const METRICS: readonly Metric[] = [
  { label: 'Schema valid', value: (s) => s.schemaValidRate, format: percent, higherIsBetter: true },
  { label: 'Within the limit', value: (s) => s.withinLimitRate, format: percent, higherIsBetter: true },
  { label: 'No platform issues', value: (s) => s.issueFreeRate, format: percent, higherIsBetter: true },
  { label: 'No forbidden words', value: (s) => s.forbiddenFreeRate, format: percent, higherIsBetter: true },
  { label: 'Right language', value: (s) => s.languageCorrectRate, format: percent, higherIsBetter: true },
  { label: 'Refusals', value: (s) => s.refusalRate, format: percent, higherIsBetter: false },
  {
    label: 'Cost per generation',
    value: (s) => s.costMicros.perGeneration,
    format: usd,
    higherIsBetter: false,
  },
  { label: 'Latency p50', value: (s) => s.latencyMs.p50, format: ms, higherIsBetter: false },
  { label: 'Latency p95', value: (s) => s.latencyMs.p95, format: ms, higherIsBetter: false },
  { label: 'Time to first token p50', value: (s) => s.ttftMs.p50, format: ms, higherIsBetter: false },
];

export interface MetricChange {
  label: string;
  previous: string;
  current: string;
  /** better, worse or same; null when one side has no value. */
  direction: 'better' | 'worse' | 'same' | null;
}

export function compareReports(previous: EvalReport | null, current: EvalReport): MetricChange[] {
  return METRICS.map((metric) => {
    const before = previous ? metric.value(previous.summary) : null;
    const now = metric.value(current.summary);
    let direction: MetricChange['direction'] = null;
    if (before !== null && now !== null) {
      direction = now === before ? 'same' : now > before === metric.higherIsBetter ? 'better' : 'worse';
    }
    return {
      label: metric.label,
      previous: before === null ? '-' : metric.format(before),
      current: now === null ? '-' : metric.format(now),
      direction,
    };
  });
}

// --- Files -----------------------------------------------------------------------------------

/** For example 2026-10-16T15-30-00Z-anthropic.json; sorting by name sorts by time. */
export const reportFileName = (report: EvalReport, extension: 'json' | 'md'): string =>
  `${report.startedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}-${report.provider}.${extension}`;

const sameCases = (a: EvalReport, b: EvalReport): boolean =>
  a.suiteVersion === b.suiteVersion &&
  a.cases.map((entry) => entry.id).join(',') === b.cases.map((entry) => entry.id).join(',');

/** The latest earlier real run of the same provider, model and cases, or null. */
export function findPreviousReport(directory: string, current: EvalReport): EvalReport | null {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => name.endsWith(`-${current.provider}.json`) && name < reportFileName(current, 'json'))
    .sort()
    .reverse();
  for (const name of candidates) {
    const report = JSON.parse(readFileSync(join(directory, name), 'utf8')) as EvalReport;
    if (report.model === current.model && !report.dryRun && sameCases(report, current)) {
      return report;
    }
  }
  return null;
}

// --- Markdown --------------------------------------------------------------------------------

export function renderMarkdown(report: EvalReport, previous: EvalReport | null): string {
  const { summary } = report;
  const lines = [
    `# AI eval: ${report.provider}, ${report.model}, ${report.promptVersion}`,
    '',
    `- Started: ${report.startedAt}, finished: ${report.finishedAt}`,
    `- Effort: ${report.effort}, suite version ${String(report.suiteVersion)}${report.dryRun ? ', dry run (estimates only)' : ''}`,
    `- Budget: ${usd(report.budgetMicros)}, ${report.dryRun ? 'estimated' : 'spent'}: ${usd(report.spentMicros)}${report.budgetExhausted ? ' (budget reached, cases skipped)' : ''}`,
    `- Generations: ${String(summary.generations.completed)} completed, ${String(summary.generations.failed)} failed (${String(summary.generations.refused)} refused), ${String(summary.generations.skipped)} not run; ${String(summary.variants)} variants checked`,
    `- Estimated upper cost per generation: ${summary.costMicros.estimatePerGeneration === null ? '-' : usd(summary.costMicros.estimatePerGeneration)}`,
    `- Compared with: ${previous ? `${previous.startedAt} (${previous.promptVersion})` : 'no earlier report'}`,
    '',
    '| Metric | Previous | Current | Change |',
    '| --- | --- | --- | --- |',
    ...compareReports(previous, report).map(
      (change) => `| ${change.label} | ${change.previous} | ${change.current} | ${change.direction ?? '-'} |`,
    ),
    '',
    '## Platforms',
    '',
    '| Platform | Variants | Within the limit | Average length | Limit |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(summary.byPlatform).map(
      ([platform, entry]) =>
        `| ${platform} | ${String(entry.variants)} | ${entry.withinLimitRate === null ? '-' : percent(entry.withinLimitRate)} | ${entry.averageLength === null ? '-' : String(Math.round(entry.averageLength))} | ${String(entry.maxLength)} |`,
    ),
    '',
    '## Cases',
    '',
    '| Case | Outcome | Cost | Latency | Findings |',
    '| --- | --- | --- | --- | --- |',
    ...report.cases.map((entry) => {
      const findings = entry.variants.flatMap((check) => [
        ...(check.schemaValid && check.matchesTarget ? [] : [`${check.targetKey} schema`]),
        ...(check.withinLimit
          ? []
          : [`${check.targetKey} too long (${String(check.length)}/${String(check.maxLength)})`]),
        ...check.issues.map((issue) => `${check.targetKey} ${issue}`),
        ...(check.forbiddenWords.length > 0
          ? [`${check.targetKey} forbidden: ${check.forbiddenWords.join(', ')}`]
          : []),
        ...(check.languageCorrect ? [] : [`${check.targetKey} language ${check.language}`]),
      ]);
      return `| ${entry.id} | ${entry.outcome} | ${usd(entry.outcome === 'dry_run' ? entry.estimateMicros : entry.costMicros)} | ${entry.latencyMs === null ? '-' : ms(entry.latencyMs)} | ${findings.length > 0 ? findings.join('; ') : '-'} |`;
    }),
    '',
  ];
  return lines.join('\n');
}
