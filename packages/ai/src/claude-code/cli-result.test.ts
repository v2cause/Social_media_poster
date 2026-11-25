import { describe, expect, it } from 'vitest';

import { failureOfResult, readCliOutcome, structuredOf, type CliResult } from './cli-result';

const result = (overrides: Partial<CliResult> = {}): CliResult => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"a":1}',
  ...overrides,
});

describe('readCliOutcome', () => {
  it('takes the last result line and skips other events', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      'not json',
      JSON.stringify(result({ result: '{"a":2}' })),
      '',
    ].join('\n');

    const read = readCliOutcome({ kind: 'exited', code: 0, stdout, stderr: '' });

    expect(read).toMatchObject({ result: { result: '{"a":2}' } });
  });

  it('treats a timeout as a retryable provider error', () => {
    expect(readCliOutcome({ kind: 'timeout' })).toMatchObject({
      failure: { code: 'PROVIDER_ERROR', retryable: true },
    });
  });

  it('explains a missing login when the CLI exits without a result', () => {
    const read = readCliOutcome({
      kind: 'exited',
      code: 1,
      stdout: '',
      stderr: 'Invalid API key - Please run /login',
    });

    expect(read).toMatchObject({ failure: { code: 'PROVIDER_ERROR', retryable: false } });
    if ('failure' in read) {
      expect(read.failure.detail).toContain('not signed in');
    }
  });
});

describe('failureOfResult', () => {
  it('accepts a successful result', () => {
    expect(failureOfResult(result())).toBeNull();
  });

  it('marks a reached subscription limit as retryable', () => {
    const failure = failureOfResult(
      result({ is_error: true, subtype: 'success', result: 'Claude AI usage limit reached' }),
    );

    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
  });

  it('maps a refusal', () => {
    expect(failureOfResult(result({ stop_reason: 'refusal' }))).toMatchObject({ code: 'REFUSED' });
  });

  it('carries the HTTP status of an API error', () => {
    expect(
      failureOfResult(result({ is_error: true, api_error_status: 529, result: 'Overloaded' })),
    ).toMatchObject({
      status: 529,
      retryable: true,
    });
  });
});

describe('structuredOf', () => {
  it('prefers the structured output and falls back to the text', () => {
    expect(structuredOf(result({ structured_output: { b: 1 } }))).toEqual({ b: 1 });
    expect(structuredOf(result())).toEqual({ a: 1 });
    expect(structuredOf(result({ result: 'plain text' }))).toBeUndefined();
  });
});
