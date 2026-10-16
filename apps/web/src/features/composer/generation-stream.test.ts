import type { GenerationEvent } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import { IDLE, readEvents, streamReducer, type StreamState } from './generation-stream';

const GENERATION = '0199f0a0-0000-7000-8000-000000000001';
const VARIANT = '0199f0a0-0000-7000-8000-000000000002';

const completed: GenerationEvent = {
  type: 'generation.completed',
  generationId: GENERATION,
  variants: [
    {
      variantId: VARIANT,
      targetKey: 't1',
      platform: 'X',
      hook: 'Hallo.',
      text: 'Hallo.',
      hashtags: [],
      firstComment: null,
      callToAction: null,
      altTexts: [],
      warnings: [],
      count: { length: 6, max: 280, overLimit: false },
      issues: [],
      forbiddenWords: [],
      autoShortened: false,
    },
  ],
};

const run = (events: GenerationEvent[]): StreamState =>
  events.reduce<StreamState>(
    (state, event) => streamReducer(state, { type: 'event', event }),
    streamReducer(IDLE, { type: 'start' }),
  );

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
};

const sse = (event: GenerationEvent): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

describe('streamReducer', () => {
  it('follows a generation from the start to the result', () => {
    expect(
      run([
        { type: 'generation.started', generationId: GENERATION },
        { type: 'variant.partial', variants: [{ targetKey: 't1', text: 'Hal' }] },
      ]),
    ).toEqual({
      status: 'streaming',
      generationId: GENERATION,
      partials: [{ targetKey: 't1', text: 'Hal' }],
    });
    expect(run([{ type: 'generation.started', generationId: GENERATION }, completed])).toMatchObject({
      status: 'completed',
      variants: [{ variantId: VARIANT }],
    });
  });

  it('drops the partial output on a reset', () => {
    expect(
      run([
        { type: 'generation.started', generationId: GENERATION },
        { type: 'variant.partial', variants: [{ text: 'Hal' }] },
        { type: 'variant.reset' },
      ]),
    ).toEqual({ status: 'streaming', generationId: GENERATION, partials: [] });
  });

  it('turns a failure into the code of the error message', () => {
    expect(
      run([
        { type: 'generation.started', generationId: GENERATION },
        { type: 'generation.failed', generationId: GENERATION, code: 'REFUSED', retryable: false },
      ]),
    ).toEqual({ status: 'failed', generationId: GENERATION, code: 'AI_REFUSED', retryable: false });
  });
});

describe('readEvents', () => {
  it('parses events split across chunks and ignores the heartbeat', async () => {
    const text = `: ping\n\n${sse({ type: 'generation.started', generationId: GENERATION })}${sse(completed)}`;
    const middle = Math.floor(text.length / 2);
    const events: GenerationEvent[] = [];

    await readEvents(streamOf([text.slice(0, 7), text.slice(7, middle), text.slice(middle)]), (event) =>
      events.push(event),
    );

    expect(events.map((event) => event.type)).toEqual(['generation.started', 'generation.completed']);
  });

  it('refuses events that do not match the contract', async () => {
    await expect(
      readEvents(streamOf(['event: variant.reset\ndata: {"type":"unknown"}\n\n']), () => undefined),
    ).rejects.toThrow();
  });
});
