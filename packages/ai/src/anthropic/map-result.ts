import { APIConnectionError, APIError, APIUserAbortError, RateLimitError } from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiFailure, AiTarget, GeneratedVariant } from '@smp/core';
import type { z } from 'zod';

// Maps responses and errors of the Anthropic SDK to the AI port (guide step 2.4).

/**
 * The text of a response. After a fallback in the middle of a stream, the content holds the
 * declined model's partial text, a fallback block and the fallback model's continuation of that
 * text; together they form the answer, so every text block counts, in order.
 */
export const collectText = (content: readonly BetaContentBlock[]): string =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

export interface FallbackSwitch {
  from: string;
  to: string;
  category: string | null;
}

/** The model switches of a response, for the logs. */
export const fallbackSwitches = (content: readonly BetaContentBlock[]): FallbackSwitch[] =>
  content.flatMap((block) =>
    block.type === 'fallback'
      ? [{ from: block.from.model, to: block.to.model, category: block.trigger.category }]
      : [],
  );

const failure = (code: AiFailure['code'], detail: string, overrides: Partial<AiFailure> = {}): AiFailure => ({
  code,
  retryable: false,
  detail,
  refusalCategory: null,
  status: null,
  ...overrides,
});

/** A failure for a stop reason that leaves no usable answer, checked before reading content. */
export function failureForStop(message: Pick<BetaMessage, 'stop_reason' | 'stop_details'>): AiFailure | null {
  switch (message.stop_reason) {
    case 'refusal':
      return failure('REFUSED', 'the model declined the request', {
        refusalCategory: message.stop_details?.category ?? null,
      });
    case 'max_tokens':
      return failure('TRUNCATED', 'the answer reached max_tokens');
    default:
      return null;
  }
}

/**
 * The code Node gives the failed connection under an APIConnectionError, such as ECONNRESET or
 * CERT_HAS_EXPIRED for a certificate that a TLS handshake refused (ASVS 16.3.4).
 */
function connectionCode(error: APIConnectionError): string | null {
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 3 && typeof cause === 'object' && cause !== null; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(code)) {
      return code;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Maps an error of a call. The order matters: in the TypeScript SDK, APIUserAbortError and
 * APIConnectionError are subclasses of APIError (architecture 5.1).
 */
export function failureFromError(error: unknown, aborted: boolean): AiFailure {
  if (error instanceof APIUserAbortError || aborted) {
    return failure('CANCELED', 'the client aborted the call');
  }
  if (error instanceof RateLimitError) {
    return failure('PROVIDER_ERROR', 'rate limited', { retryable: true, status: 429 });
  }
  if (error instanceof APIConnectionError) {
    const code = connectionCode(error);
    const reason = code === null ? error.constructor.name : `${error.constructor.name} (${code})`;
    return failure('PROVIDER_ERROR', `connection failed: ${reason}`, { retryable: true });
  }
  if (error instanceof APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    return failure('PROVIDER_ERROR', `API error ${String(status)}`, {
      retryable: status !== null && (status >= 500 || status === 408 || status === 409),
      status,
    });
  }
  return failure('PROVIDER_ERROR', error instanceof Error ? error.name : 'unknown error');
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; failure: AiFailure };

/** Parses and validates the structured output; the schema guarantees no more than the API does. */
export function parseStructured<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, failure: failure('INVALID_OUTPUT', 'the answer is not valid JSON') };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, failure: failure('INVALID_OUTPUT', 'the answer does not match the schema') };
}

/** The variants in the order of the targets, if the answer has exactly one per target. */
export function matchTargets(
  variants: readonly GeneratedVariant[],
  targets: readonly AiTarget[],
): GeneratedVariant[] | null {
  if (variants.length !== targets.length) {
    return null;
  }
  const ordered: GeneratedVariant[] = [];
  for (const target of targets) {
    const variant = variants.find((candidate) => candidate.targetKey === target.key);
    if (variant?.platform !== target.platform) {
      return null;
    }
    ordered.push(variant);
  }
  return ordered;
}
