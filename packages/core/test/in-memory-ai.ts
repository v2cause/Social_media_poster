import {
  CostCalculator,
  fixedQuotaLimits,
  QuotaService,
  type AiCallReport,
  type AiDependencies,
  type AiFailure,
  type AiGenerationEntry,
  type AiProvider,
  type AiRequest,
  type AiResult,
  type GeneratedVariant,
  type GenerateVariantsInput,
  type ModelPrice,
  type QuotaKey,
  type QuotaStore,
  type RefineVariantInput,
  type SuggestAltTextInput,
  type SuggestTopicsInput,
  type TopicIdea,
  type UsageSettlement,
  type VariantStreamEvent,
} from '../src';
import { createContentTestbed, type ContentTestbed } from './in-memory-content';

// Fakes for the AI use cases: a scripted provider, the quota in memory and a fixed price book.

export class MemoryQuotaStore implements QuotaStore {
  readonly counters = new Map<string, bigint>();
  readonly ledger: (UsageSettlement & { key: QuotaKey })[] = [];

  private id = (key: QuotaKey): string =>
    `${key.organizationId}/${key.meter}/${key.periodStart.toISOString()}`;

  reserve(key: QuotaKey, amount: bigint, limit: bigint): Promise<bigint | null> {
    const value = (this.counters.get(this.id(key)) ?? 0n) + amount;
    if (value > limit) {
      return Promise.resolve(null);
    }
    this.counters.set(this.id(key), value);
    return Promise.resolve(value);
  }

  settle(key: QuotaKey, settlement: UsageSettlement): Promise<boolean> {
    if (
      this.ledger.some(
        (entry) => entry.sourceType === settlement.sourceType && entry.sourceId === settlement.sourceId,
      )
    ) {
      return Promise.resolve(false);
    }
    this.ledger.push({ ...settlement, key });
    const value = (this.counters.get(this.id(key)) ?? 0n) + settlement.quantity - settlement.reserved;
    this.counters.set(this.id(key), value < 0n ? 0n : value);
    return Promise.resolve(true);
  }

  current(key: QuotaKey): Promise<bigint> {
    return Promise.resolve(this.counters.get(this.id(key)) ?? 0n);
  }

  /** The counter of the only period the tests use. */
  total(): bigint {
    return [...this.counters.values()].reduce((sum, value) => sum + value, 0n);
  }
}

// 4 USD input and 20 USD output per million tokens.
export const OPUS_PRICE: ModelPrice = {
  inputMicrosPerMtok: 4_000_000n,
  outputMicrosPerMtok: 20_000_000n,
  cacheReadMicrosPerMtok: 200_000n,
  cacheWrite5mMicrosPerMtok: 5_000_000n,
  cacheWrite1hMicrosPerMtok: 8_000_000n,
};

export const reportOf = (overrides: Partial<AiCallReport> = {}): AiCallReport => ({
  provider: 'fake',
  promptVersion: 'gen-v1',
  modelRequested: 'claude-opus-5-5',
  modelServed: 'claude-opus-5-5',
  effort: 'medium',
  // 1000 input and 1000 output tokens: 4000 + 20000 = 24000 micro-USD.
  attempts: [
    {
      kind: 'message',
      model: 'claude-opus-5-5',
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
  ],
  stopReason: 'end_turn',
  refusalCategory: null,
  ttftMs: 10,
  latencyMs: 100,
  ...overrides,
});

export const failureOf = (code: AiFailure['code'], retryable = false): AiFailure => ({
  code,
  retryable,
  detail: code,
  refusalCategory: code === 'REFUSED' ? 'general_harms' : null,
  status: null,
});

export const variantFor = (
  target: { key: string; platform: GeneratedVariant['platform'] },
  text: string,
): GeneratedVariant => ({
  targetKey: target.key,
  platform: target.platform,
  hook: text.split('.')[0] ?? text,
  text,
  hashtags: [],
  firstComment: null,
  callToAction: null,
  altTexts: [],
  warnings: [],
});

type Script<I> = (input: I, signal?: AbortSignal) => AsyncIterable<VariantStreamEvent>;

/** A stream of the given events; with an error, it throws after the last event. */
export async function* streamOf(
  events: readonly VariantStreamEvent[],
  error?: Error,
): AsyncGenerator<VariantStreamEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
  if (error) {
    throw error;
  }
}

/** A provider whose answers the test scripts; it records every call. */
export class ScriptedProvider implements AiProvider {
  readonly name = 'fake';
  readonly promptVersion = 'gen-v1';
  readonly calls: { method: string; input: unknown; effort: string }[] = [];

  generate: Script<GenerateVariantsInput> = (input) =>
    streamOf([
      { type: 'partial', variants: [{ targetKey: input.targets[0]?.key ?? 't1', text: 'Hal' }] },
      {
        type: 'completed',
        variants: input.targets.map((target) => variantFor(target, `Hallo ${target.platform}.`)),
        report: reportOf(),
      },
    ]);

  refine: Script<RefineVariantInput> = (input) =>
    streamOf([
      {
        type: 'completed',
        variants: [variantFor(input.target, 'Kurz.')],
        report: reportOf({ effort: 'low' }),
      },
    ]);

  topics: (input: SuggestTopicsInput) => Promise<AiResult<TopicIdea[]>> = (input) =>
    Promise.resolve({
      ok: true,
      value: Array.from({ length: input.count }, (_, index) => ({
        title: `Idee ${String(index + 1)}`,
        angle: 'Ein Blickwinkel',
        pillar: null,
        whyNow: 'Jetzt',
        basedOn: ['Firmenprofil'],
        suggestedPlatforms: ['LINKEDIN'],
        suggestedStyleKey: 'educational',
        format: 'Textbeitrag',
      })),
      report: reportOf(),
    });

  generateVariants(input: GenerateVariantsInput, options: { effort: string; signal?: AbortSignal }) {
    this.calls.push({ method: 'generateVariants', input, effort: options.effort });
    return this.generate(input, options.signal);
  }

  refineVariant(input: RefineVariantInput, options: { effort: string; signal?: AbortSignal }) {
    this.calls.push({ method: 'refineVariant', input, effort: options.effort });
    return this.refine(input, options.signal);
  }

  suggestTopics(input: SuggestTopicsInput, options: { effort: string }) {
    this.calls.push({ method: 'suggestTopics', input, effort: options.effort });
    return this.topics(input);
  }

  altText: (input: SuggestAltTextInput) => Promise<AiResult<string>> = () =>
    Promise.resolve({ ok: true, value: 'Ein Bild.', report: reportOf() });

  suggestAltText(input: SuggestAltTextInput, options: { effort: string }): Promise<AiResult<string>> {
    this.calls.push({ method: 'suggestAltText', input, effort: options.effort });
    return this.altText(input);
  }
}

export interface AiTestbed extends ContentTestbed {
  deps: AiDependencies;
  provider: ScriptedProvider;
  quotaStore: MemoryQuotaStore;
  generations: AiGenerationEntry[];
  estimates: AiRequest[];
  warnings: string[];
}

export function createAiTestbed(options: { limit?: bigint } = {}): AiTestbed {
  const content = createContentTestbed();
  const provider = new ScriptedProvider();
  const quotaStore = new MemoryQuotaStore();
  const generations: AiGenerationEntry[] = [];
  const estimates: AiRequest[] = [];
  const warnings: string[] = [];
  const deps: AiDependencies = {
    unitOfWork: content.unitOfWork,
    provider,
    estimator: {
      estimate: (request) => {
        estimates.push(request);
        // 50000 + 50000 micro-USD at the price above.
        return { inputTokens: 12_500, outputTokens: 2_500 };
      },
    },
    quota: new QuotaService({
      store: quotaStore,
      limits: fixedQuotaLimits({ ai_micros: options.limit ?? 10_000_000n }),
      clock: content.clock,
    }),
    costs: new CostCalculator({
      prices: { pricesAt: () => Promise.resolve(new Map([['claude-opus-5-5', OPUS_PRICE]])) },
      clock: content.clock,
    }),
    log: {
      record: (entry) => {
        generations.push(entry);
        return Promise.resolve();
      },
    },
    clock: content.clock,
    ids: content.ids,
    model: 'claude-opus-5-5',
    efforts: { generate: 'medium', refine: 'low', ideas: 'medium', altText: 'low' },
    warn: (message) => warnings.push(message),
  };
  return { ...content, deps, provider, quotaStore, generations, estimates, warnings };
}
