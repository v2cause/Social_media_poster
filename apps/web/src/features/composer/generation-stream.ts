import { apiErrorOf } from '@smp/api-client';
import {
  generationEventSchema,
  type GeneratedVariantDto,
  type GenerationEvent,
  type PartialVariantDto,
} from '@smp/contracts';
import { createParser } from 'eventsource-parser';

// The client side of the AI streams (guide step 2.8): fetch with POST, eventsource-parser for the
// event stream, and a reducer for the state the composer renders. Errors before the stream
// (404, 402, 429, ...) arrive as problem documents and become an ApiError.

export type StreamState =
  | { status: 'idle' }
  | { status: 'streaming'; generationId: string | null; partials: PartialVariantDto[] }
  | { status: 'completed'; generationId: string; variants: GeneratedVariantDto[] }
  /** The stream ended with generation.failed: an AI_<code> message applies. */
  | { status: 'failed'; generationId: string | null; code: string; retryable: boolean }
  /** The request failed before the stream, for example 402 QUOTA_EXCEEDED. */
  | { status: 'error'; error: unknown };

export type StreamAction =
  | { type: 'start' }
  | { type: 'event'; event: GenerationEvent }
  | { type: 'error'; error: unknown }
  | { type: 'cancel' };

export const IDLE: StreamState = { status: 'idle' };

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'start':
      return { status: 'streaming', generationId: null, partials: [] };
    case 'cancel':
      return IDLE;
    case 'error':
      return { status: 'error', error: action.error };
    case 'event': {
      const { event } = action;
      const generationId = state.status === 'streaming' ? state.generationId : null;
      switch (event.type) {
        case 'generation.started':
          return { status: 'streaming', generationId: event.generationId, partials: [] };
        case 'variant.partial':
          return { status: 'streaming', generationId, partials: event.variants };
        case 'variant.reset':
          return { status: 'streaming', generationId, partials: [] };
        case 'generation.completed':
          return { status: 'completed', generationId: event.generationId, variants: event.variants };
        case 'generation.failed':
          return {
            status: 'failed',
            generationId: event.generationId,
            code: `AI_${event.code}`,
            retryable: event.retryable,
          };
      }
    }
  }
}

/** Calls onEvent for every event of a server-sent event stream, validated against the contract. */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: GenerationEvent) => void,
): Promise<void> {
  const parser = createParser({
    onEvent: (message) => {
      onEvent(generationEventSchema.parse(JSON.parse(message.data)));
    },
  });
  // A streaming decoder keeps characters whole that arrive split across two chunks.
  const decoder = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      parser.feed(decoder.decode());
      return;
    }
    parser.feed(decoder.decode(value, { stream: true }));
  }
}

/** Starts an AI stream with POST; resolves when the stream ends. */
export async function postStream(
  url: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: GenerationEvent) => void,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    throw await apiErrorOf(response);
  }
  await readEvents(response.body, onEvent);
}
