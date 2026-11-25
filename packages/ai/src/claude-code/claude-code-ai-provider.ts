import type {
  AiCallOptions,
  AiCallReport,
  AiEffort,
  AiFailure,
  AiProvider,
  AiResult,
  AltTextImage,
  BrandContext,
  GeneratedDiagram,
  GenerateDiagramInput,
  GenerateVariantsInput,
  RefineVariantInput,
  SuggestAltTextInput,
  SuggestTopicsInput,
  TopicIdea,
  VariantStreamEvent,
} from '@smp/core';
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { matchTargets } from '../anthropic/map-result';
import { renderBrandContext } from '../prompts/render-brand-context';
import {
  renderAltTextTask,
  renderDiagramTask,
  renderGenerateTask,
  renderRefineTask,
  renderTopicsTask,
} from '../prompts/render-task';
import { renderSystemPrompt } from '../prompts/system-prompt';
import { PROMPT_VERSION } from '../prompts/version';
import {
  altTextOutputSchema,
  diagramOutputSchema,
  topicIdeasOutputSchema,
  variantsOutputSchema,
} from '../schemas';
import type { ClaudeCliRunner } from './claude-cli';
import { failureOfResult, readCliOutcome, servedModelOf, structuredOf } from './cli-result';

// AiProvider on the Claude Code CLI (ADR 0047): the prompts of the Claude API provider, sent through
// `claude -p` with the user's Claude subscription instead of an API key.
//
// - No tools (--tools ""), no MCP servers, no slash commands, no saved session: the CLI answers like
//   a plain model call.
// - --system-prompt-file replaces the coding prompt of Claude Code with the system prompt of the
//   posts and the brand context, so the instructions are the same as with the API.
// - --json-schema returns the answer as validated JSON; zod checks it once more here.
// - --bare is never used: it switches off the subscription login.
// - The answer arrives as a whole, so generation emits one completed event and no partials.
// - The report has no attempts, so the call costs nothing in the price book (see call()).

export interface ClaudeCodeAiProviderConfig {
  runner: ClaudeCliRunner;
  /** AI_MODEL, passed to --model. */
  model: string;
  /** How long one call may take. */
  timeoutMs: number;
}

interface CallSpec {
  brand: BrandContext | null;
  text: string;
  image?: AltTextImage;
  schema: z.ZodType;
}

// Draft 7: the validator of the CLI does not know the draft 2020-12 that zod writes by default
// and refuses such a schema.
const jsonSchemaOf = (schema: z.ZodType): string =>
  JSON.stringify(z.toJSONSchema(schema, { target: 'draft-7' }));

export class ClaudeCodeAiProvider implements AiProvider {
  readonly name = 'claude-code';
  readonly promptVersion = PROMPT_VERSION;

  constructor(private readonly config: ClaudeCodeAiProviderConfig) {}

  generateVariants(input: GenerateVariantsInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent> {
    return this.variants(
      { brand: input.brand, text: renderGenerateTask(input), schema: variantsOutputSchema },
      input.targets,
      options,
    );
  }

  refineVariant(input: RefineVariantInput, options: AiCallOptions): AsyncIterable<VariantStreamEvent> {
    return this.variants(
      { brand: input.brand, text: renderRefineTask(input), schema: variantsOutputSchema },
      [input.target],
      options,
    );
  }

  async suggestTopics(input: SuggestTopicsInput, options: AiCallOptions): Promise<AiResult<TopicIdea[]>> {
    const result = await this.call(
      { brand: input.brand, text: renderTopicsTask(input), schema: topicIdeasOutputSchema },
      topicIdeasOutputSchema,
      options,
    );
    return result.ok ? { ...result, value: result.value.ideas.slice(0, input.count) } : result;
  }

  async suggestAltText(input: SuggestAltTextInput, options: AiCallOptions): Promise<AiResult<string>> {
    const result = await this.call(
      { brand: null, text: renderAltTextTask(input), image: input.image, schema: altTextOutputSchema },
      altTextOutputSchema,
      options,
    );
    return result.ok ? { ...result, value: result.value.altText } : result;
  }

  generateDiagram(input: GenerateDiagramInput, options: AiCallOptions): Promise<AiResult<GeneratedDiagram>> {
    return this.call(
      { brand: input.brand, text: renderDiagramTask(input), schema: diagramOutputSchema },
      diagramOutputSchema,
      options,
    );
  }

  private async *variants(
    spec: CallSpec,
    targets: GenerateVariantsInput['targets'],
    options: AiCallOptions,
  ): AsyncGenerator<VariantStreamEvent> {
    const result = await this.call(spec, variantsOutputSchema, options);
    if (!result.ok) {
      yield { type: 'failed', failure: result.failure, report: result.report };
      return;
    }
    const variants = matchTargets(result.value.variants, targets);
    if (!variants) {
      yield {
        type: 'failed',
        failure: invalid('the answer does not have exactly one variant per target'),
        report: result.report,
      };
      return;
    }
    yield { type: 'completed', variants, report: result.report };
  }

  private async call<T>(spec: CallSpec, schema: z.ZodType<T>, options: AiCallOptions): Promise<AiResult<T>> {
    const started = performance.now();
    const report = (extra: Partial<AiCallReport> = {}): AiCallReport => ({
      provider: this.name,
      promptVersion: PROMPT_VERSION,
      modelRequested: this.config.model,
      modelServed: null,
      effort: options.effort,
      attempts: [],
      stopReason: null,
      refusalCategory: null,
      ttftMs: null,
      latencyMs: Math.round(performance.now() - started),
      ...extra,
    });

    const system = spec.brand
      ? `${renderSystemPrompt()}\n${renderBrandContext(spec.brand)}`
      : renderSystemPrompt();
    const outcome = await this.config.runner.run({
      // One file per distinct prompt: the system prompt and a brand context repeat across calls.
      args: this.args(
        this.config.runner.writeFile(
          `system-${createHash('sha256').update(system).digest('hex').slice(0, 24)}.md`,
          system,
        ),
        spec.schema,
        options.effort,
      ),
      input: `${JSON.stringify(userMessage(spec))}\n`,
      timeoutMs: this.config.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const read = readCliOutcome(outcome);
    if ('failure' in read) {
      return { ok: false, failure: read.failure, report: report() };
    }
    const { result } = read;
    const done = report({
      modelServed: servedModelOf(result),
      // No attempts: the subscription does not bill tokens, and attempts would be priced as API
      // usage against the AI quota and the usage meter.
      stopReason: result.stop_reason ?? null,
      ttftMs: result.ttft_ms !== undefined ? Math.round(result.ttft_ms) : null,
    });
    const stopFailure = failureOfResult(result);
    if (stopFailure) {
      return {
        ok: false,
        failure: stopFailure,
        report: { ...done, refusalCategory: stopFailure.refusalCategory },
      };
    }
    const parsed = schema.safeParse(structuredOf(result));
    return parsed.success
      ? { ok: true, value: parsed.data, report: done }
      : { ok: false, failure: invalid('the answer does not match the output schema'), report: done };
  }

  private args(systemPromptFile: string, schema: z.ZodType, effort: AiEffort): string[] {
    return [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--model',
      this.config.model,
      '--effort',
      effort,
      '--system-prompt-file',
      systemPromptFile,
      '--json-schema',
      jsonSchemaOf(schema),
    ];
  }
}

function userMessage(spec: CallSpec): unknown {
  const content: unknown[] = [];
  if (spec.image) {
    content.push(
      spec.image.kind === 'url'
        ? { type: 'image', source: { type: 'url', url: spec.image.url } }
        : {
            type: 'image',
            source: { type: 'base64', media_type: spec.image.mediaType, data: spec.image.data },
          },
    );
  }
  content.push({ type: 'text', text: spec.text });
  return { type: 'user', message: { role: 'user', content } };
}

const invalid = (detail: string): AiFailure => ({
  code: 'INVALID_OUTPUT',
  retryable: false,
  detail,
  refusalCategory: null,
  status: null,
});
