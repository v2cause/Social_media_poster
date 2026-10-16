import { setTimeout as sleep } from 'node:timers/promises';

import type {
  AiAttempt,
  AiCallOptions,
  AiCallReport,
  AiEffort,
  AiFailure,
  AiProvider,
  AiResult,
  GeneratedVariant,
  GenerateVariantsInput,
  RefineVariantInput,
  SuggestAltTextInput,
  SuggestTopicsInput,
  TopicIdea,
  VariantStreamEvent,
} from '@smp/core';

import { IMAGE_TOKENS } from '../estimate';
import { partialVariants } from '../partial-variants';
import { estimateTokens } from '../pricing';
import { renderBrandContext } from '../prompts/render-brand-context';
import {
  renderAltTextTask,
  renderGenerateTask,
  renderRefineTask,
  renderTopicsTask,
} from '../prompts/render-task';
import { renderSystemPrompt } from '../prompts/system-prompt';
import { PROMPT_VERSION } from '../prompts/version';
import { composeAltText, composeIdeas, composeVariants, refineVariantText } from './compose';
import { triggersOf, type MockTrigger } from './text';

// AiProvider without network for development and every automated test (guide step 2.5,
// architecture 7). Deterministic: the same input gives the same output. It streams the JSON of
// its answer in chunks, so partial events, resets and failures reach the client as they do with
// the Claude API. Markers in the brief select the other paths:
//
//   [mock:refusal]    partial output, then REFUSED
//   [mock:truncated]  partial output, reset, partial output again, then TRUNCATED
//   [mock:retry]      partial output, reset, then the complete answer (the max_tokens retry)
//   [mock:invalid]    the complete answer, then INVALID_OUTPUT
//   [mock:error]      PROVIDER_ERROR as after an overloaded API (529), retryable
//   [mock:fallback]   the complete answer from the server-side fallback model
//   [mock:slow]       longer pauses between the chunks
//   [mock:too-long]   variants over the text limit of their platform
//
// For a refinement, the markers count in the current text and the instruction. The reports name
// the configured model with estimated tokens (the cached prompt prefix as cache reads), so quota
// and costs run as in production. Never active in production (createAiProvider, aiEnvSchema).

export interface MockAiProviderConfig {
  /** AI_MODEL: the model the reports name. */
  model: string;
  /** The model that answers on the [mock:fallback] path. */
  fallbackModel?: string;
  /** The pause between two chunks of a stream. */
  chunkDelayMs?: number;
  /** The pause between two chunks on the [mock:slow] path. */
  slowChunkDelayMs?: number;
  /** Chunks per answer: a long answer gets longer chunks, not a longer stream. */
  chunks?: number;
}

/** The share of the answer that streams before a refusal or a cut-off. */
const REFUSED_AT = 0.25;
const CUT_AT = 0.6;
/** The share of the answer the declined model wrote before the server switched models. */
const FALLBACK_AT = 0.3;

const failure = (code: AiFailure['code'], detail: string, overrides: Partial<AiFailure> = {}): AiFailure => ({
  code,
  retryable: false,
  detail,
  refusalCategory: null,
  status: null,
  ...overrides,
});

const CANCELED = failure('CANCELED', 'the client aborted the call');

/** Waits; false when the signal aborted before or during the pause. */
async function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  try {
    await sleep(ms, undefined, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) {
      return false;
    }
    throw error;
  }
  return true;
}

/** The state of one call, for its report. */
class MockCall {
  private readonly started = performance.now();
  private ttftMs: number | null = null;
  readonly attempts: AiAttempt[] = [];
  modelServed: string | null = null;
  stopReason: string | null = null;
  refusalCategory: string | null = null;

  constructor(
    private readonly model: string,
    private readonly effort: AiEffort,
    /** Tokens of the uncached task and of the cached prefix (system prompt and brand context). */
    private readonly tokens: { input: number; cached: number },
  ) {}

  firstChunk(): void {
    this.ttftMs ??= Math.round(performance.now() - this.started);
  }

  attempt(kind: AiAttempt['kind'], model: string, output: string): void {
    this.attempts.push({
      kind,
      model,
      inputTokens: this.tokens.input,
      outputTokens: estimateTokens(output),
      cacheReadTokens: this.tokens.cached,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
  }

  answered(model: string, stopReason: string): void {
    this.modelServed = model;
    this.stopReason = stopReason;
  }

  report(): AiCallReport {
    return {
      provider: 'mock',
      promptVersion: PROMPT_VERSION,
      modelRequested: this.model,
      modelServed: this.modelServed,
      effort: this.effort,
      attempts: this.attempts,
      stopReason: this.stopReason,
      refusalCategory: this.refusalCategory,
      ttftMs: this.ttftMs,
      latencyMs: Math.round(performance.now() - this.started),
    };
  }
}

export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  readonly promptVersion = PROMPT_VERSION;
  private readonly fallbackModel: string;
  private readonly chunkDelayMs: number;
  private readonly slowChunkDelayMs: number;
  private readonly chunks: number;

  constructor(private readonly config: MockAiProviderConfig) {
    this.fallbackModel = config.fallbackModel ?? 'claude-opus-5';
    this.chunkDelayMs = config.chunkDelayMs ?? 20;
    this.slowChunkDelayMs = config.slowChunkDelayMs ?? 250;
    this.chunks = config.chunks ?? 40;
  }

  generateVariants(input: GenerateVariantsInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent> {
    const triggers = triggersOf(input.brief);
    const variants = composeVariants(input, triggers.has('too-long'));
    const call = this.call(options.effort, renderGenerateTask(input), renderBrandContext(input.brand));
    return this.stream(variants, call, triggers, options.signal);
  }

  refineVariant(input: RefineVariantInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent> {
    const triggers = triggersOf(`${input.variant.text}\n${input.instruction ?? ''}`);
    const call = this.call(options.effort, renderRefineTask(input), renderBrandContext(input.brand));
    return this.stream([refineVariantText(input)], call, triggers, options.signal);
  }

  async suggestTopics(input: SuggestTopicsInput, options: AiCallOptions): Promise<AiResult<TopicIdea[]>> {
    const call = this.call(options.effort, renderTopicsTask(input), renderBrandContext(input.brand));
    const ideas = composeIdeas(input);
    return this.answer(call, ideas, JSON.stringify({ ideas }), options.signal);
  }

  async suggestAltText(input: SuggestAltTextInput, options: AiCallOptions): Promise<AiResult<string>> {
    const call = new MockCall(this.config.model, options.effort, {
      input: estimateTokens(renderAltTextTask(input)) + IMAGE_TOKENS,
      cached: estimateTokens(renderSystemPrompt()),
    });
    const altText = composeAltText(input);
    return this.answer(call, altText, JSON.stringify({ altText }), options.signal);
  }

  private call(effort: AiEffort, task: string, brandContext: string): MockCall {
    return new MockCall(this.config.model, effort, {
      input: estimateTokens(task),
      cached: estimateTokens(renderSystemPrompt() + brandContext),
    });
  }

  private async answer<T>(
    call: MockCall,
    value: T,
    output: string,
    signal: AbortSignal | undefined,
  ): Promise<AiResult<T>> {
    if (!(await pause(this.chunkDelayMs * 5, signal))) {
      return { ok: false, failure: CANCELED, report: call.report() };
    }
    call.firstChunk();
    call.attempt('message', this.config.model, output);
    call.answered(this.config.model, 'end_turn');
    return { ok: true, value, report: call.report() };
  }

  /**
   * Streams the JSON of the answer up to `end` as partial events. Returns how much of it went out
   * before the end or an abort.
   */
  private async *emit(
    output: string,
    end: number,
    delay: number,
    call: MockCall,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<VariantStreamEvent, { sent: number; aborted: boolean }> {
    const size = Math.max(16, Math.ceil(output.length / this.chunks));
    let sent = 0;
    let last = '';
    while (sent < end) {
      if (!(await pause(delay, signal))) {
        return { sent, aborted: true };
      }
      call.firstChunk();
      sent = Math.min(sent + size, end);
      const variants = partialVariants(output.slice(0, sent));
      const serialized = JSON.stringify(variants);
      if (variants && serialized !== last) {
        last = serialized;
        yield { type: 'partial', variants };
      }
    }
    return { sent, aborted: false };
  }

  private async *stream(
    variants: GeneratedVariant[],
    call: MockCall,
    triggers: ReadonlySet<MockTrigger>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<VariantStreamEvent> {
    const { model } = this.config;
    const output = JSON.stringify({ variants });
    const delay = triggers.has('slow') ? this.slowChunkDelayMs : this.chunkDelayMs;
    const at = (share: number): number => Math.ceil(output.length * share);
    const canceled = (sent: number): VariantStreamEvent => {
      call.attempt('message', model, output.slice(0, sent));
      return { type: 'failed', failure: CANCELED, report: call.report() };
    };

    if (triggers.has('error')) {
      if (!(await pause(delay, signal))) {
        yield { type: 'failed', failure: CANCELED, report: call.report() };
        return;
      }
      const overloaded = failure('PROVIDER_ERROR', 'API error 529', { retryable: true, status: 529 });
      yield { type: 'failed', failure: overloaded, report: call.report() };
      return;
    }

    if (triggers.has('refusal')) {
      const round = yield* this.emit(output, at(REFUSED_AT), delay, call, signal);
      if (round.aborted) {
        yield canceled(round.sent);
        return;
      }
      call.attempt('message', model, output.slice(0, round.sent));
      call.answered(model, 'refusal');
      call.refusalCategory = 'general_harms';
      const refused = failure('REFUSED', 'the model declined the request', {
        refusalCategory: 'general_harms',
      });
      yield { type: 'failed', failure: refused, report: call.report() };
      return;
    }

    if (triggers.has('truncated') || triggers.has('retry')) {
      const first = yield* this.emit(output, at(CUT_AT), delay, call, signal);
      if (first.aborted) {
        yield canceled(first.sent);
        return;
      }
      call.attempt('message', model, output.slice(0, first.sent));
      yield { type: 'reset' };
      const end = triggers.has('truncated') ? at(CUT_AT) : output.length;
      const second = yield* this.emit(output, end, delay, call, signal);
      if (second.aborted) {
        yield canceled(second.sent);
        return;
      }
      call.attempt('message', model, output.slice(0, second.sent));
      if (triggers.has('truncated')) {
        call.answered(model, 'max_tokens');
        yield {
          type: 'failed',
          failure: failure('TRUNCATED', 'the answer reached max_tokens'),
          report: call.report(),
        };
        return;
      }
      call.answered(model, 'end_turn');
      yield { type: 'completed', variants, report: call.report() };
      return;
    }

    const round = yield* this.emit(output, output.length, delay, call, signal);
    if (round.aborted) {
      yield canceled(round.sent);
      return;
    }
    if (triggers.has('fallback')) {
      // The declined model wrote the start, the fallback model continued it.
      call.attempt('message', model, output.slice(0, at(FALLBACK_AT)));
      call.attempt('fallback_message', this.fallbackModel, output.slice(at(FALLBACK_AT)));
      call.answered(this.fallbackModel, 'end_turn');
    } else {
      call.attempt('message', model, output);
      call.answered(model, 'end_turn');
    }
    if (triggers.has('invalid')) {
      const invalid = failure('INVALID_OUTPUT', 'the answer does not match the schema');
      yield { type: 'failed', failure: invalid, report: call.report() };
      return;
    }
    yield { type: 'completed', variants, report: call.report() };
  }
}
