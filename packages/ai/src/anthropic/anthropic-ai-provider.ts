import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaTextBlockParam,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  AiAttempt,
  AiCallOptions,
  AiCallReport,
  AiEffort,
  AiFailure,
  AiProvider,
  AiResult,
  AiTarget,
  AltTextImage,
  BrandContext,
  GenerateVariantsInput,
  RefineVariantInput,
  SuggestAltTextInput,
  SuggestTopicsInput,
  TopicIdea,
  VariantStreamEvent,
} from '@smp/core';
import type { z } from 'zod';

import { partialVariants } from '../partial-variants';
import { attemptsFromUsage, estimateTokens } from '../pricing';
import { renderBrandContext } from '../prompts/render-brand-context';
import {
  renderAltTextTask,
  renderGenerateTask,
  renderRefineTask,
  renderTopicsTask,
} from '../prompts/render-task';
import { renderSystemPrompt } from '../prompts/system-prompt';
import { PROMPT_VERSION } from '../prompts/version';
import { altTextOutputSchema, topicIdeasOutputSchema, variantsOutputSchema } from '../schemas';
import {
  collectText,
  failureForStop,
  failureFromError,
  fallbackSwitches,
  matchTargets,
  parseStructured,
} from './map-result';

// AiProvider on the Claude API (guide step 2.4, architecture 5.1, ADR 0007 and 0015).
//
// - No temperature, no assistant prefill and no thinking setting: claude-opus-5-5 rejects all
//   three. Thinking is adaptive; the effort is fixed per route so the prompt cache holds.
// - Two cache breakpoints: the system prompt (same for every tenant) and the brand context.
// - Server-side fallback ("default", beta server-side-fallback-2026-07-01) unless switched off.
//   A fallback in the middle of a stream continues the partial output, so the text of all
//   blocks forms the answer; nothing is reset.
// - The structured output schema is sent without the SDK's automatic parsing, because that
//   parses every text block on its own and throws on a fallback continuation or a cut-off
//   answer. The stop reason is checked first, then the joined text is validated with zod.
// - Prompts and outputs never go to the logs.

export interface AiLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface AnthropicAiProviderConfig {
  apiKey: string;
  /** AI_MODEL, claude-opus-5-5 by default. */
  model: string;
  /** AI_REFUSAL_FALLBACK: server-side fallback after a policy refusal. */
  refusalFallback: boolean;
  maxTokens?: number;
  /** The limit of the single retry after an answer stopped at max_tokens. */
  retryMaxTokens?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Partial events are sent at most this often. */
  partialIntervalMs?: number;
  logger?: AiLogger;
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// The structured output formats without their parse functions (see above).
const formatOf = (schema: z.ZodType) => {
  const { type, schema: jsonSchema } = betaZodOutputFormat(schema);
  return { type, schema: jsonSchema };
};
const FORMATS = {
  variants: formatOf(variantsOutputSchema),
  ideas: formatOf(topicIdeasOutputSchema),
  altText: formatOf(altTextOutputSchema),
};

type RoundResult = { message: BetaMessage } | { failure: AiFailure };

interface CallSpec {
  brand: BrandContext | null;
  content: string | BetaContentBlockParam[];
  format: (typeof FORMATS)[keyof typeof FORMATS];
}

/** The state of one call across its rounds (a retry after max_tokens is a second round). */
class CallState {
  readonly started = performance.now();
  readonly attempts: AiAttempt[] = [];
  ttftMs: number | null = null;
  modelServed: string | null = null;
  stopReason: string | null = null;
  refusalCategory: string | null = null;

  constructor(
    readonly modelRequested: string,
    readonly effort: AiEffort,
  ) {}

  firstText(): void {
    this.ttftMs ??= Math.round(performance.now() - this.started);
  }

  report(): AiCallReport {
    return {
      provider: 'anthropic',
      promptVersion: PROMPT_VERSION,
      modelRequested: this.modelRequested,
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

export class AnthropicAiProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly promptVersion = PROMPT_VERSION;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly retryMaxTokens: number;
  private readonly partialIntervalMs: number;

  constructor(private readonly config: AnthropicAiProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      maxRetries: config.maxRetries ?? 2,
      timeout: config.timeoutMs ?? 120_000,
    });
    this.maxTokens = config.maxTokens ?? 16_000;
    this.retryMaxTokens = config.retryMaxTokens ?? 32_000;
    this.partialIntervalMs = config.partialIntervalMs ?? 50;
  }

  generateVariants(input: GenerateVariantsInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent> {
    return this.streamVariants(input.brand, renderGenerateTask(input), input.targets, options);
  }

  refineVariant(input: RefineVariantInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent> {
    return this.streamVariants(input.brand, renderRefineTask(input), [input.target], options);
  }

  async suggestTopics(input: SuggestTopicsInput, options: AiCallOptions): Promise<AiResult<TopicIdea[]>> {
    const result = await this.call(
      { brand: input.brand, content: renderTopicsTask(input), format: FORMATS.ideas },
      topicIdeasOutputSchema,
      options,
    );
    return result.ok ? { ...result, value: result.value.ideas.slice(0, input.count) } : result;
  }

  async suggestAltText(input: SuggestAltTextInput, options: AiCallOptions): Promise<AiResult<string>> {
    const content: BetaContentBlockParam[] = [imageBlock(input.image), textBlock(renderAltTextTask(input))];
    const result = await this.call(
      { brand: null, content, format: FORMATS.altText },
      altTextOutputSchema,
      options,
    );
    return result.ok ? { ...result, value: result.value.altText } : result;
  }

  private request(spec: CallSpec, effort: AiEffort, maxTokens: number): MessageCreateParamsBase {
    const system: BetaTextBlockParam[] = [
      { type: 'text', text: renderSystemPrompt(), cache_control: { type: 'ephemeral' } },
    ];
    if (spec.brand) {
      system.push({
        type: 'text',
        text: renderBrandContext(spec.brand),
        cache_control: { type: 'ephemeral' },
      });
    }
    return {
      model: this.config.model,
      max_tokens: maxTokens,
      ...(this.config.refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      output_config: { effort, format: spec.format },
      system,
      messages: [{ role: 'user', content: spec.content }],
    };
  }

  /**
   * Runs one round: yields the text so far after every text delta and returns the final message.
   * On an abort or an error, the attempt made so far is recorded with its known input tokens and
   * the estimated output. Ending the iteration early aborts the request.
   */
  private async *round(
    spec: CallSpec,
    state: CallState,
    maxTokens: number,
    options: AiCallOptions,
  ): AsyncGenerator<string, RoundResult> {
    const stream = this.client.beta.messages.stream(
      this.request(spec, state.effort, maxTokens),
      options.signal ? { signal: options.signal } : {},
    );
    let text = '';
    let finished = false;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          state.firstText();
          text += event.delta.text;
          yield text;
        }
      }
      const message = await stream.finalMessage();
      finished = true;
      return { message };
    } catch (error) {
      finished = true;
      const partial = stream.currentMessage;
      if (partial) {
        const { usage } = partial;
        state.attempts.push({
          kind: 'message',
          model: partial.model,
          inputTokens: usage.input_tokens,
          outputTokens: Math.max(usage.output_tokens, estimateTokens(text)),
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWrite5mTokens: usage.cache_creation_input_tokens ?? 0,
          cacheWrite1hTokens: 0,
        });
      }
      const failure = failureFromError(error, options.signal?.aborted ?? false);
      if (failure.code !== 'CANCELED') {
        this.config.logger?.warn(
          { code: failure.code, status: failure.status, detail: failure.detail },
          'ai.call_failed',
        );
      }
      return { failure };
    } finally {
      if (!finished) {
        stream.abort();
      }
    }
  }

  /** Records a finished round and returns the failure its stop reason means, if any. */
  private finish(state: CallState, message: BetaMessage): AiFailure | null {
    const attempts = attemptsFromUsage(message.usage, this.config.model, message.model);
    state.attempts.push(...attempts);
    // After a fallback in the middle of a stream, message_start (and so message.model) still
    // names the requested model; the attempt that answered is the last fallback_message.
    state.modelServed =
      attempts.findLast((attempt) => attempt.kind === 'fallback_message')?.model ?? message.model;
    state.stopReason = message.stop_reason;
    for (const change of fallbackSwitches(message.content)) {
      this.config.logger?.info({ ...change }, 'ai.fallback');
    }
    const failure = failureForStop(message);
    if (failure?.code === 'REFUSED') {
      state.refusalCategory = failure.refusalCategory;
    }
    return failure;
  }

  private async *streamVariants(
    brand: BrandContext,
    content: string,
    targets: readonly AiTarget[],
    options: AiCallOptions,
  ): AsyncGenerator<VariantStreamEvent> {
    const spec: CallSpec = { brand, content, format: FORMATS.variants };
    const state = new CallState(this.config.model, options.effort);
    let maxTokens = this.maxTokens;

    for (let round = 1; ; round += 1) {
      let lastEmit = Number.NEGATIVE_INFINITY;
      let lastPartial = '';
      const rounds = this.round(spec, state, maxTokens, options);
      let step = await rounds.next();
      try {
        while (!step.done) {
          const now = performance.now();
          if (now - lastEmit >= this.partialIntervalMs) {
            const variants = partialVariants(step.value);
            const serialized = JSON.stringify(variants);
            if (variants && serialized !== lastPartial) {
              lastEmit = now;
              lastPartial = serialized;
              yield { type: 'partial', variants };
            }
          }
          step = await rounds.next();
        }
      } finally {
        if (!step.done) {
          await rounds.return({ failure: invalid('the consumer stopped reading') });
        }
      }
      const result = step.value;
      if ('failure' in result) {
        yield { type: 'failed', failure: result.failure, report: state.report() };
        return;
      }
      const stopFailure = this.finish(state, result.message);
      if (stopFailure?.code === 'TRUNCATED' && round === 1) {
        // One retry with a higher limit; the client drops what it has seen so far.
        maxTokens = this.retryMaxTokens;
        yield { type: 'reset' };
        continue;
      }
      if (stopFailure) {
        yield { type: 'failed', failure: stopFailure, report: state.report() };
        return;
      }
      const parsed = parseStructured(collectText(result.message.content), variantsOutputSchema);
      const variants = parsed.ok ? matchTargets(parsed.value.variants, targets) : null;
      if (!parsed.ok || !variants) {
        const failure = parsed.ok
          ? invalid('the answer does not have exactly one variant per target')
          : parsed.failure;
        yield { type: 'failed', failure, report: state.report() };
        return;
      }
      yield { type: 'completed', variants, report: state.report() };
      return;
    }
  }

  private async call<T>(spec: CallSpec, schema: z.ZodType<T>, options: AiCallOptions): Promise<AiResult<T>> {
    const state = new CallState(this.config.model, options.effort);
    let maxTokens = this.maxTokens;
    for (let round = 1; ; round += 1) {
      const rounds = this.round(spec, state, maxTokens, options);
      let step = await rounds.next();
      while (!step.done) {
        step = await rounds.next();
      }
      const result = step.value;
      if ('failure' in result) {
        return { ok: false, failure: result.failure, report: state.report() };
      }
      const stopFailure = this.finish(state, result.message);
      if (stopFailure?.code === 'TRUNCATED' && round === 1) {
        maxTokens = this.retryMaxTokens;
        continue;
      }
      if (stopFailure) {
        return { ok: false, failure: stopFailure, report: state.report() };
      }
      const parsed = parseStructured(collectText(result.message.content), schema);
      return parsed.ok
        ? { ok: true, value: parsed.value, report: state.report() }
        : { ok: false, failure: parsed.failure, report: state.report() };
    }
  }
}

const invalid = (detail: string): AiFailure => ({
  code: 'INVALID_OUTPUT',
  retryable: false,
  detail,
  refusalCategory: null,
  status: null,
});

const textBlock = (text: string): BetaTextBlockParam => ({ type: 'text', text });

function imageBlock(image: AltTextImage): BetaContentBlockParam {
  return image.kind === 'url'
    ? { type: 'image', source: { type: 'url', url: image.url } }
    : { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } };
}
