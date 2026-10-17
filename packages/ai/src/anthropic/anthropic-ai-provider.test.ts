import type { BrandContext, GenerateVariantsInput, VariantStreamEvent } from '@smp/core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AnthropicAiProvider, type AiLogger, type AnthropicAiProviderConfig } from './anthropic-ai-provider';

// Guide step 2.4: every path of the provider against a simulated Claude API (msw intercepts
// the fetch calls of the SDK): ok, refusal, fallback in the middle of the stream, max_tokens,
// invalid JSON, 429, 529, a connection error and an abort by the client.

const API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5-5';

const brand: BrandContext = {
  profile: {
    name: 'Brand Studio',
    industry: 'Software',
    targetAudience: null,
    goals: null,
    contentPillars: [],
  },
  voice: null,
  customStyles: [],
};

const input: GenerateVariantsInput = {
  brand,
  styleKey: 'professional',
  targets: [
    { key: 't1', platform: 'LINKEDIN' },
    { key: 't2', platform: 'X' },
  ],
  language: 'de',
  brief: 'Der neue Kalender ist da.',
  mediaDescriptions: [],
};

const variant = (targetKey: string, platform: string, text: string) => ({
  targetKey,
  platform,
  hook: text.split('.')[0] ?? text,
  text,
  hashtags: ['kalender'],
  firstComment: null,
  callToAction: null,
  altTexts: [],
  warnings: [],
});

const ANSWER = JSON.stringify({
  variants: [
    variant('t1', 'LINKEDIN', 'Der neue Kalender ist da. Planen Sie Ihre Woche in Minuten.'),
    variant('t2', 'X', 'Der neue Kalender ist da.'),
  ],
});

// --- SSE responses of the Messages API ---------------------------------------------------------

type Event = Record<string, unknown> & { type: string };

const usage = (overrides: Record<string, unknown> = {}) => ({
  input_tokens: 1200,
  output_tokens: 1,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 300,
  cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
  iterations: null,
  ...overrides,
});

const messageStart = (model = MODEL): Event => ({
  type: 'message_start',
  message: {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: usage(),
  },
});

const textBlock = (index: number, text: string, chunk = 12): Event[] => {
  const deltas: Event[] = [];
  for (let offset = 0; offset < text.length; offset += chunk) {
    deltas.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: text.slice(offset, offset + chunk) },
    });
  }
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } },
    ...deltas,
    { type: 'content_block_stop', index },
  ];
};

const messageEnd = (
  stopReason: string,
  extra: { stopDetails?: unknown; usage?: Record<string, unknown> } = {},
): Event[] => [
  {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: extra.stopDetails ?? null,
      container: null,
    },
    usage: {
      output_tokens: 640,
      input_tokens: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      iterations: null,
      ...extra.usage,
    },
    context_management: null,
  },
  { type: 'message_stop' },
];

const sse = (events: Event[]): string =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const streamResponse = (events: Event[]) =>
  new HttpResponse(sse(events), { headers: { 'content-type': 'text/event-stream' } });

const answer = (text = ANSWER): Event[] => [messageStart(), ...textBlock(0, text), ...messageEnd('end_turn')];

// --- harness -------------------------------------------------------------------------------------

const server = setupServer();
const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
// Reading a request body is asynchronous; each test waits for its own requests to be recorded.
const recording: Promise<void>[] = [];

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', ({ request }) => {
    recording.push(
      request
        .clone()
        .json()
        .then((body: unknown) => {
          requests.push({ headers: request.headers, body: body as Record<string, unknown> });
        }),
    );
  });
});
afterEach(async () => {
  await Promise.all(recording);
  recording.length = 0;
  server.resetHandlers();
  requests.length = 0;
});
afterAll(() => {
  server.close();
});

function provider(
  overrides: Partial<AnthropicAiProviderConfig> = {},
  logs: string[] = [],
): AnthropicAiProvider {
  const logger: AiLogger = {
    info: (_fields, message) => logs.push(`info ${message}`),
    warn: (_fields, message) => logs.push(`warn ${message}`),
  };
  return new AnthropicAiProvider({
    apiKey: 'sk-ant-test',
    model: MODEL,
    refusalFallback: true,
    partialIntervalMs: 0,
    logger,
    ...overrides,
  });
}

async function collect(events: AsyncIterable<VariantStreamEvent>): Promise<VariantStreamEvent[]> {
  const all: VariantStreamEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

const last = (events: VariantStreamEvent[]): VariantStreamEvent => {
  const event = events.at(-1);
  if (!event) {
    throw new Error('no events');
  }
  return event;
};

const apiError = (status: number, type: string, headers: Record<string, string> = {}) =>
  HttpResponse.json(
    { type: 'error', error: { type, message: type } },
    { status, headers: { 'retry-after-ms': '1', ...headers } },
  );

// --- tests ---------------------------------------------------------------------------------------

describe('AnthropicAiProvider', () => {
  it('streams partial variants and completes with the variants in target order', async () => {
    server.use(http.post(API, () => streamResponse(answer())));

    const events = await collect(provider().generateVariants(input, { effort: 'medium' }));

    const partials = events.filter((event) => event.type === 'partial');
    expect(partials.length).toBeGreaterThan(1);
    const completed = last(events);
    expect(completed.type).toBe('completed');
    if (completed.type !== 'completed') {
      return;
    }
    expect(completed.variants.map((item) => item.targetKey)).toEqual(['t1', 't2']);
    expect(completed.report).toMatchObject({
      provider: 'anthropic',
      promptVersion: 'gen-v2',
      modelRequested: MODEL,
      modelServed: MODEL,
      effort: 'medium',
      stopReason: 'end_turn',
      refusalCategory: null,
      attempts: [
        {
          kind: 'message',
          model: MODEL,
          inputTokens: 1200,
          outputTokens: 640,
          cacheReadTokens: 900,
          cacheWrite5mTokens: 300,
          cacheWrite1hTokens: 0,
        },
      ],
    });
    expect(completed.report.ttftMs).not.toBeNull();
  });

  it('sends the request the model expects: effort, schema, two cache breakpoints, fallback', async () => {
    server.use(http.post(API, () => streamResponse(answer())));
    await collect(provider().generateVariants(input, { effort: 'medium' }));

    await expect.poll(() => requests.length).toBe(1);
    const [request] = requests;
    expect(request?.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
    const body = request?.body ?? {};
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: 16_000,
      fallbacks: 'default',
      stream: true,
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
    });
    // claude-opus-5-5 rejects sampling parameters, a disabled thinking and an assistant prefill.
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('thinking');
    expect(body['messages']).toEqual([
      { role: 'user', content: expect.stringContaining('<brief>') as string },
    ]);
    const system = body['system'] as { text: string; cache_control: unknown }[];
    expect(system).toHaveLength(2);
    expect(system.map((block) => block.cache_control)).toEqual([
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ]);
    expect(system[1]?.text).toContain('<brand_context>');
  });

  it('leaves the fallback out when AI_REFUSAL_FALLBACK is off', async () => {
    server.use(http.post(API, () => streamResponse(answer())));
    await collect(provider({ refusalFallback: false }).generateVariants(input, { effort: 'medium' }));

    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]?.headers.get('anthropic-beta')).toBeNull();
    expect(requests[0]?.body).not.toHaveProperty('fallbacks');
  });

  it('reports a refusal with its category and does not retry it', async () => {
    server.use(
      http.post(API, () =>
        streamResponse([
          messageStart(),
          ...messageEnd('refusal', {
            stopDetails: { type: 'refusal', category: 'bio', explanation: 'declined' },
            usage: { output_tokens: 0 },
          }),
        ]),
      ),
    );

    const events = await collect(provider().generateVariants(input, { effort: 'medium' }));

    expect(events).toHaveLength(1);
    expect(last(events)).toMatchObject({
      type: 'failed',
      failure: { code: 'REFUSED', refusalCategory: 'bio', retryable: false },
      report: { refusalCategory: 'bio', stopReason: 'refusal' },
    });
    expect(requests).toHaveLength(1);
  });

  it('keeps the partial output when a fallback model continues it in the middle of the stream', async () => {
    const half = Math.floor(ANSWER.length / 2);
    const logs: string[] = [];
    server.use(
      http.post(API, () =>
        streamResponse([
          messageStart(),
          ...textBlock(0, ANSWER.slice(0, half)),
          {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'fallback',
              from: { model: MODEL },
              to: { model: 'claude-opus-4-8' },
              trigger: { type: 'refusal', category: 'cyber' },
            },
          },
          { type: 'content_block_stop', index: 1 },
          ...textBlock(2, ANSWER.slice(half)),
          ...messageEnd('end_turn', {
            usage: {
              output_tokens: 400,
              iterations: [
                {
                  type: 'message',
                  model: MODEL,
                  input_tokens: 1200,
                  output_tokens: 240,
                  cache_read_input_tokens: 900,
                  cache_creation_input_tokens: 300,
                  cache_creation: null,
                },
                {
                  type: 'fallback_message',
                  model: 'claude-opus-4-8',
                  input_tokens: 1450,
                  output_tokens: 400,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_creation: null,
                },
              ],
            },
          }),
        ]),
      ),
    );

    const events = await collect(provider({}, logs).generateVariants(input, { effort: 'medium' }));

    expect(events.some((event) => event.type === 'reset')).toBe(false);
    const completed = last(events);
    expect(completed).toMatchObject({ type: 'completed', report: { modelServed: 'claude-opus-4-8' } });
    if (completed.type === 'completed') {
      expect(completed.variants).toHaveLength(2);
      expect(completed.report.attempts.map((attempt) => [attempt.kind, attempt.model])).toEqual([
        ['message', MODEL],
        ['fallback_message', 'claude-opus-4-8'],
      ]);
    }
    expect(logs).toEqual(['info ai.fallback']);
  });

  it('retries once with a higher limit after max_tokens and tells the client to reset', async () => {
    let call = 0;
    server.use(
      http.post(API, () => {
        call += 1;
        return streamResponse(
          call === 1
            ? [messageStart(), ...textBlock(0, ANSWER.slice(0, 80)), ...messageEnd('max_tokens')]
            : answer(),
        );
      }),
    );

    const events = await collect(provider().generateVariants(input, { effort: 'medium' }));

    const types = events.map((event) => event.type);
    expect(types).toContain('reset');
    expect(types.indexOf('reset')).toBeGreaterThan(types.indexOf('partial'));
    expect(last(events).type).toBe('completed');
    await expect.poll(() => requests.map((request) => request.body['max_tokens'])).toEqual([16_000, 32_000]);
    const completed = last(events);
    if (completed.type === 'completed') {
      expect(completed.report.attempts).toHaveLength(2);
    }
  });

  it('fails with TRUNCATED when the retry stops at max_tokens again', async () => {
    server.use(
      http.post(API, () =>
        streamResponse([messageStart(), ...textBlock(0, '{"variants":['), ...messageEnd('max_tokens')]),
      ),
    );

    const events = await collect(provider().generateVariants(input, { effort: 'medium' }));

    expect(last(events)).toMatchObject({ type: 'failed', failure: { code: 'TRUNCATED' } });
    expect(requests).toHaveLength(2);
  });

  it('fails with INVALID_OUTPUT on text that is no JSON or misses a target', async () => {
    server.use(http.post(API, () => streamResponse(answer('Hier sind Ihre Posts.'))));
    expect(last(await collect(provider().generateVariants(input, { effort: 'medium' })))).toMatchObject({
      type: 'failed',
      failure: { code: 'INVALID_OUTPUT' },
    });

    const oneVariant = JSON.stringify({ variants: [variant('t1', 'LINKEDIN', 'Nur LinkedIn.')] });
    server.use(http.post(API, () => streamResponse(answer(oneVariant))));
    expect(last(await collect(provider().generateVariants(input, { effort: 'medium' })))).toMatchObject({
      type: 'failed',
      failure: { code: 'INVALID_OUTPUT' },
    });
  });

  it('reports a rate limit after the SDK retries as a retryable provider error', async () => {
    server.use(http.post(API, () => apiError(429, 'rate_limit_error')));

    const events = await collect(provider().generateVariants(input, { effort: 'medium' }));

    expect(last(events)).toMatchObject({
      type: 'failed',
      failure: { code: 'PROVIDER_ERROR', retryable: true, status: 429 },
    });
    // maxRetries 2: the first attempt and two retries.
    expect(requests).toHaveLength(3);
  });

  it('reports an overloaded API (529) as a retryable provider error', async () => {
    server.use(http.post(API, () => apiError(529, 'overloaded_error')));

    const events = await collect(provider({ maxRetries: 0 }).generateVariants(input, { effort: 'medium' }));

    expect(last(events)).toMatchObject({
      type: 'failed',
      failure: { code: 'PROVIDER_ERROR', retryable: true, status: 529 },
    });
  });

  it('reports a connection error as a retryable provider error without a status', async () => {
    const logs: string[] = [];
    server.use(http.post(API, () => HttpResponse.error()));

    const events = await collect(
      provider({ maxRetries: 0 }, logs).generateVariants(input, { effort: 'medium' }),
    );

    expect(last(events)).toMatchObject({
      type: 'failed',
      failure: { code: 'PROVIDER_ERROR', retryable: true, status: null },
    });
    expect(logs).toEqual(['warn ai.call_failed']);
  });

  it('stops when the client aborts and reports CANCELED without logging an error', async () => {
    const logs: string[] = [];
    const encoder = new TextEncoder();
    server.use(
      http.post(API, () => {
        // Sends the start and some text, then keeps the connection open.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(sse([messageStart(), ...textBlock(0, ANSWER.slice(0, 60))].slice(0, -1))),
            );
          },
        });
        return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    const abort = new AbortController();

    const events: VariantStreamEvent[] = [];
    for await (const event of provider({}, logs).generateVariants(input, {
      effort: 'medium',
      signal: abort.signal,
    })) {
      events.push(event);
      if (event.type === 'partial') {
        abort.abort();
      }
    }

    expect(last(events)).toMatchObject({ type: 'failed', failure: { code: 'CANCELED' } });
    const failed = last(events);
    if (failed.type === 'failed') {
      // The input tokens of the started attempt are known; the output is estimated.
      expect(failed.report.attempts).toMatchObject([{ kind: 'message', inputTokens: 1200 }]);
    }
    expect(logs).toEqual([]);
  });

  it('suggests topic ideas and alt texts with the same request rules', async () => {
    const ideas = JSON.stringify({
      ideas: [
        {
          title: 'Drei Wege zu mehr Reichweite',
          angle: 'Was unsere Kunden anders machen',
          pillar: null,
          whyNow: 'Jahresplanung',
          basedOn: ['content pillar'],
          suggestedPlatforms: ['LINKEDIN'],
          suggestedStyleKey: 'educational',
          format: 'carousel',
        },
      ],
    });
    server.use(http.post(API, () => streamResponse(answer(ideas))));
    const topics = await provider().suggestTopics(
      {
        brand,
        language: 'de',
        count: 10,
        recentPosts: [],
        topPosts: [],
        discardedIdeas: [],
        upcomingDates: [],
      },
      { effort: 'medium' },
    );
    expect(topics).toMatchObject({ ok: true, value: [{ title: 'Drei Wege zu mehr Reichweite' }] });

    server.use(
      http.post(API, () =>
        streamResponse(answer(JSON.stringify({ altText: 'Ein Kalender auf einem Laptop.' }))),
      ),
    );
    const alt = await provider().suggestAltText(
      { language: 'de', image: { kind: 'url', url: 'https://cdn.example.test/a.jpg' }, context: null },
      { effort: 'low' },
    );
    expect(alt).toMatchObject({ ok: true, value: 'Ein Kalender auf einem Laptop.' });

    await expect.poll(() => requests.length).toBe(2);
    const altRequest = requests[1]?.body ?? {};
    expect(altRequest['system']).toHaveLength(1);
    expect(altRequest['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://cdn.example.test/a.jpg' } },
          { type: 'text', text: expect.stringContaining('type: alt_text') as string },
        ],
      },
    ]);
  });
});
