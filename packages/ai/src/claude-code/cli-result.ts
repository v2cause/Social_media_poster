import type { AiFailure } from '@smp/core';
import { z } from 'zod';

import type { CliOutcome } from './claude-cli';

// The answer of `claude -p --output-format stream-json`: one JSON object per line, the last one of
// type "result". Only the fields this provider reads are validated; the CLI sends many more.

export const cliResultSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  stop_reason: z.string().nullable().optional(),
  api_error_status: z.number().int().nullable().optional(),
  ttft_ms: z.number().nonnegative().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

export type CliResult = z.infer<typeof cliResultSchema>;

const failure = (
  code: AiFailure['code'],
  retryable: boolean,
  detail: string,
  status: number | null = null,
): AiFailure => ({
  code,
  retryable,
  detail,
  refusalCategory: null,
  status,
});

/** Texts of the CLI that are safe to log: they never contain the prompt. Long ones are cut. */
const short = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300);

const USAGE_LIMIT = /usage limit|rate limit|limit reached|too many requests|overloaded/i;
const NOT_SIGNED_IN = /log ?in|invalid api key|authenticat|unauthori[sz]ed|oauth/i;

/** The result line of the output, or the failure the outcome of the process means. */
export function readCliOutcome(outcome: CliOutcome): { result: CliResult } | { failure: AiFailure } {
  switch (outcome.kind) {
    case 'aborted':
      return { failure: failure('CANCELED', false, 'the call was canceled') };
    case 'timeout':
      return { failure: failure('PROVIDER_ERROR', true, 'the claude CLI did not answer in time') };
    case 'not-found':
      return {
        failure: failure(
          'PROVIDER_ERROR',
          false,
          `the claude CLI was not found (${outcome.binary}); install Claude Code or set CLAUDE_CODE_PATH`,
        ),
      };
    case 'spawn-failed':
      return {
        failure: failure('PROVIDER_ERROR', false, `the claude CLI could not start (${outcome.message})`),
      };
    case 'exited':
      break;
  }
  const lines = outcome.stdout.split('\n').filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index] ?? '');
    } catch {
      continue;
    }
    const result = cliResultSchema.safeParse(parsed);
    if (result.success) {
      return { result: result.data };
    }
  }
  const message = short(outcome.stderr || outcome.stdout) || 'no output';
  return { failure: errorFailure(message, null, `the claude CLI exited with ${String(outcome.code)}`) };
}

function errorFailure(message: string, status: number | null, prefix: string): AiFailure {
  if (status === 429 || status === 529 || USAGE_LIMIT.test(message)) {
    return failure('PROVIDER_ERROR', true, `${prefix}: subscription limit or overload: ${message}`, status);
  }
  if (status === 401 || NOT_SIGNED_IN.test(message)) {
    return failure(
      'PROVIDER_ERROR',
      false,
      `${prefix}: not signed in to Claude (run claude once and log in): ${message}`,
      status,
    );
  }
  return failure('PROVIDER_ERROR', status !== null && status >= 500, `${prefix}: ${message}`, status);
}

/** The failure a result line means, if it is not a usable answer. */
export function failureOfResult(result: CliResult): AiFailure | null {
  if (result.stop_reason === 'refusal') {
    return { ...failure('REFUSED', false, 'the model refused the request'), refusalCategory: 'unknown' };
  }
  if (result.is_error || result.subtype !== 'success') {
    return errorFailure(
      short(result.result ?? result.subtype),
      result.api_error_status ?? null,
      `the claude CLI reported ${result.subtype}`,
    );
  }
  return null;
}

/** The structured answer: the validated object of --json-schema, or the text parsed as JSON. */
export function structuredOf(result: CliResult): unknown {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return result.structured_output;
  }
  if (result.result === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(result.result);
  } catch {
    return undefined;
  }
}

/** The model that answered: the first model of the usage by model, if the CLI names one. */
export const servedModelOf = (result: CliResult): string | null =>
  Object.keys(result.modelUsage ?? {})[0] ?? null;
