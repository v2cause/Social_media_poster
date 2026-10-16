import type { PartialVariant } from '@smp/core';
import { Allow, parse } from 'partial-json';

// Turns the JSON text of a streaming answer into partial variants (guide step 2.4): the server
// parses once, the client renders the variants as they grow.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The variants of the text so far, or null while not even the array has started. */
export function partialVariants(text: string): PartialVariant[] | null {
  let json: unknown;
  try {
    json = parse(text, Allow.ALL);
  } catch {
    return null;
  }
  if (!isRecord(json) || !Array.isArray(json['variants'])) {
    return null;
  }
  return json['variants'].filter(isRecord).map((variant) => variant as PartialVariant);
}
