import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compareReports, findPreviousReport, renderMarkdown, reportFileName, summarize } from './report';
import type { CaseResult, EvalReport } from './types';

const check = (fields: Partial<CaseResult['variants'][number]> = {}): CaseResult['variants'][number] => ({
  targetKey: 't1',
  platform: 'LINKEDIN',
  schemaValid: true,
  matchesTarget: true,
  length: 900,
  maxLength: 3000,
  withinLimit: true,
  issues: [],
  forbiddenWords: [],
  language: 'de',
  languageCorrect: true,
  ...fields,
});

const result = (fields: Partial<CaseResult> = {}): CaseResult => ({
  id: 'de-professional',
  language: 'de',
  styleKey: 'professional',
  outcome: 'completed',
  estimateMicros: 90_000,
  costMicros: 40_000,
  modelServed: 'claude-opus-5-5',
  attempts: 1,
  latencyMs: 8_000,
  ttftMs: 1_200,
  tokens: { input: 3_000, output: 1_000, cacheRead: 2_000, cacheWrite: 0 },
  variants: [
    check(),
    check({ targetKey: 't2', platform: 'X', length: 300, maxLength: 280, withinLimit: false }),
  ],
  ...fields,
});

const report = (cases: CaseResult[], fields: Partial<EvalReport> = {}): EvalReport => ({
  version: 1,
  startedAt: '2026-10-16T12:00:00.000Z',
  finishedAt: '2026-10-16T12:05:00.000Z',
  provider: 'anthropic',
  promptVersion: 'gen-v1',
  model: 'claude-opus-5-5',
  effort: 'medium',
  dryRun: false,
  budgetMicros: 2_000_000,
  spentMicros: cases.reduce((sum, entry) => sum + entry.costMicros, 0),
  budgetExhausted: false,
  suiteVersion: 1,
  cases,
  summary: summarize(cases),
  ...fields,
});

describe('summarize', () => {
  it('rates the variants of completed cases and counts failures', () => {
    const summary = summarize([
      result(),
      result({ id: 'de-casual', outcome: 'REFUSED', costMicros: 10_000, variants: [] }),
      result({ id: 'de-storytelling', outcome: 'skipped_budget', costMicros: 0, variants: [] }),
    ]);

    expect(summary.generations).toEqual({ total: 3, completed: 1, refused: 1, failed: 1, skipped: 1 });
    expect(summary.refusalRate).toBe(0.5);
    expect(summary.withinLimitRate).toBe(0.5);
    expect(summary.costMicros).toMatchObject({ total: 50_000, perGeneration: 25_000 });
    expect(summary.byPlatform.X).toEqual({
      variants: 1,
      withinLimitRate: 0,
      averageLength: 300,
      maxLength: 280,
    });
  });
});

describe('compareReports', () => {
  it('tells for every metric whether it got better or worse', () => {
    const before = report([result({ costMicros: 50_000 })]);
    const after = report([result({ costMicros: 40_000, variants: [check()] })]);

    const changes = compareReports(before, after);

    expect(changes.find((change) => change.label === 'Within the limit')).toEqual({
      label: 'Within the limit',
      previous: '50.0 %',
      current: '100.0 %',
      direction: 'better',
    });
    expect(changes.find((change) => change.label === 'Cost per generation')?.direction).toBe('better');
    expect(changes.find((change) => change.label === 'Schema valid')?.direction).toBe('same');
    expect(compareReports(null, after).every((change) => change.direction === null)).toBe(true);
  });
});

describe('report files', () => {
  it('finds the latest earlier real run of the same provider, model and cases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eval-'));
    const write = (entry: EvalReport) => {
      writeFileSync(join(directory, reportFileName(entry, 'json')), JSON.stringify(entry));
    };
    write(report([result()], { startedAt: '2026-10-01T10:00:00.000Z' }));
    write(report([result()], { startedAt: '2026-10-02T10:00:00.000Z', promptVersion: 'gen-v0' }));
    write(report([result()], { startedAt: '2026-10-03T10:00:00.000Z', dryRun: true }));
    write(report([result()], { startedAt: '2026-10-04T10:00:00.000Z', model: 'claude-sonnet-5-5' }));
    write(report([result()], { startedAt: '2026-10-05T10:00:00.000Z', provider: 'mock' }));
    write(report([result({ id: 'en-casual' })], { startedAt: '2026-10-05T11:00:00.000Z' }));
    const current = report([result()], { startedAt: '2026-10-06T10:00:00.000Z' });

    expect(findPreviousReport(directory, current)?.startedAt).toBe('2026-10-02T10:00:00.000Z');
    expect(reportFileName(current, 'md')).toBe('2026-10-06T10-00-00Z-anthropic.md');
    expect(findPreviousReport(join(directory, 'missing'), current)).toBeNull();
  });

  it('renders the comparison, the platforms and every case with its findings', () => {
    const markdown = renderMarkdown(report([result()]), null);

    expect(markdown).toContain('# AI eval: anthropic, claude-opus-5-5, gen-v1');
    expect(markdown).toContain('| Within the limit | - | 50.0 % | - |');
    expect(markdown).toContain('| X | 1 | 0.0 % | 300 | 280 |');
    expect(markdown).toContain('| de-professional | completed | $0.0400 | 8000 ms | t2 too long (300/280) |');
  });
});
