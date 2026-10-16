import type {
  AiTarget,
  BrandContext,
  BrandVoiceContent,
  ContentLanguage,
  GeneratedVariant,
  GenerateVariantsInput,
  RefineAction,
  RefineVariantInput,
  SuggestTopicsInput,
  VariantStreamEvent,
} from '@smp/core';
import { composePostText, countText } from '@smp/platform-rules';
import { describe, expect, it } from 'vitest';

import { STYLE_PRESETS } from '../prompts/style-presets';
import { altTextOutputSchema, topicIdeasOutputSchema, variantsOutputSchema } from '../schemas';
import { MockAiProvider, type MockAiProviderConfig } from './mock-ai-provider';

// Guide step 2.5: the mock answers deterministically per style and platform, streams like the
// Claude API and reaches every failure path through markers in the brief.

const brand: BrandContext = {
  profile: {
    name: 'Acme',
    industry: 'Software',
    targetAudience: 'Teams in Mittelstand',
    goals: null,
    contentPillars: ['Produkt', 'Team'],
  },
  voice: null,
  customStyles: [],
};

const voice = (overrides: Partial<BrandVoiceContent>): BrandVoiceContent => ({
  name: 'Acme',
  description: 'Klar und freundlich.',
  tone: ['klar'],
  dos: [],
  donts: [],
  vocabulary: [],
  forbiddenWords: [],
  emojiPolicy: 'none',
  hashtagPolicy: 'normal',
  examplePosts: [],
  language: 'de',
  ...overrides,
});

const TARGETS: AiTarget[] = [
  { key: 't1', platform: 'LINKEDIN' },
  { key: 't2', platform: 'X' },
  { key: 't3', platform: 'INSTAGRAM' },
  { key: 't4', platform: 'FACEBOOK' },
];

const BRIEF = 'Wir eröffnen unser neues Büro in Köln. Dazu laden wir alle Kunden ein.';
const TOPIC = 'Wir eröffnen unser neues Büro in Köln';

const generateInput = (overrides: Partial<GenerateVariantsInput> = {}): GenerateVariantsInput => ({
  brand,
  styleKey: 'professional',
  targets: TARGETS,
  language: 'de',
  brief: BRIEF,
  mediaDescriptions: [],
  ...overrides,
});

const mock = (config: Partial<MockAiProviderConfig> = {}): MockAiProvider =>
  new MockAiProvider({ model: 'claude-opus-5-5', chunkDelayMs: 0, ...config });

async function collect(events: AsyncIterable<VariantStreamEvent>): Promise<VariantStreamEvent[]> {
  const all: VariantStreamEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

function lastOf<T extends VariantStreamEvent['type']>(
  events: VariantStreamEvent[],
  type: T,
): Extract<VariantStreamEvent, { type: T }> {
  const last = events.at(-1);
  if (last?.type !== type) {
    throw new Error(`expected the stream to end with ${type}, got ${String(last?.type)}`);
  }
  return last as Extract<VariantStreamEvent, { type: T }>;
}

const generate = async (
  overrides: Partial<GenerateVariantsInput> = {},
  config: Partial<MockAiProviderConfig> = {},
): Promise<VariantStreamEvent[]> =>
  collect(mock(config).generateVariants(generateInput(overrides), { effort: 'medium' }));

const generated = async (overrides: Partial<GenerateVariantsInput> = {}): Promise<GeneratedVariant[]> =>
  lastOf(await generate(overrides), 'completed').variants;

const types = (events: VariantStreamEvent[]): string[] =>
  events.map((event) => event.type).filter((type, index, all) => type !== all[index - 1]);

const lengthOf = (variant: Pick<GeneratedVariant, 'platform' | 'text' | 'hashtags'>) =>
  countText(variant.platform, composePostText(variant.text, variant.hashtags));

describe('MockAiProvider.generateVariants', () => {
  it('streams growing partial variants and completes with one valid variant per target', async () => {
    const events = await generate();
    const { variants, report } = lastOf(events, 'completed');

    expect(types(events)).toEqual(['partial', 'completed']);
    expect(variantsOutputSchema.parse({ variants })).toEqual({ variants });
    expect(variants.map((variant) => [variant.targetKey, variant.platform])).toEqual(
      TARGETS.map((target) => [target.key, target.platform]),
    );
    const finalText = variants[0]?.text ?? '';
    for (const event of events) {
      if (event.type === 'partial') {
        expect(finalText.startsWith(event.variants[0]?.text ?? '')).toBe(true);
      }
    }
    expect(report).toMatchObject({
      provider: 'mock',
      promptVersion: 'gen-v1',
      modelRequested: 'claude-opus-5-5',
      modelServed: 'claude-opus-5-5',
      effort: 'medium',
      stopReason: 'end_turn',
      refusalCategory: null,
    });
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({ kind: 'message', model: 'claude-opus-5-5' });
    expect(report.attempts[0]?.inputTokens).toBeGreaterThan(0);
    expect(report.attempts[0]?.outputTokens).toBeGreaterThan(0);
    // The system prompt and the brand context count as cache reads.
    expect(report.attempts[0]?.cacheReadTokens).toBeGreaterThan(1000);
    expect(report.ttftMs).not.toBeNull();
  });

  it('answers the same input with the same variants', async () => {
    expect(await generated()).toEqual(await generated());
  });

  it('writes posts within the limits of every platform, in every style and language', async () => {
    for (const language of ['de', 'en'] as const) {
      for (const { key } of STYLE_PRESETS) {
        for (const variant of await generated({ language, styleKey: key })) {
          expect(lengthOf(variant).overLimit, `${language} ${key} ${variant.platform}`).toBe(false);
          expect(variant.text.startsWith(variant.hook)).toBe(true);
          expect(variant.text).toContain(TOPIC);
        }
      }
    }
  });

  it('varies the text with style and language, and uses one set of texts for custom styles', async () => {
    const professional = await generated();
    const storytelling = await generated({ styleKey: 'storytelling' });
    const english = await generated({ language: 'en' });
    const custom = await generated({ styleKey: 'custom-house' });
    const otherCustom = await generated({ styleKey: 'custom-short' });

    expect(storytelling[0]?.text).not.toEqual(professional[0]?.text);
    expect(english[0]?.text).not.toEqual(professional[0]?.text);
    expect(english[0]?.hook).toBe(`${TOPIC}: what matters now.`);
    expect(custom[0]?.hook).toBe(`${TOPIC}: Unsere Sicht in wenigen Sätzen.`);
    expect(otherCustom).toEqual(custom);
  });

  it('shapes the variants per platform', async () => {
    const [linkedin, x, instagram, facebook] = await generated();

    expect(linkedin?.hashtags).toHaveLength(3);
    expect(x?.hashtags).toHaveLength(2);
    expect(instagram?.hashtags).toHaveLength(5);
    expect(facebook?.hashtags).toHaveLength(2);
    expect(x?.text.split('\n\n')).toHaveLength(2);
    expect(linkedin?.text.split('\n\n')).toHaveLength(4);
    expect(linkedin?.callToAction).toBe(linkedin?.text.split('\n\n').at(-1));
  });

  it('follows the hashtag policy of the brand voice', async () => {
    const none = await generated({ brand: { ...brand, voice: voice({ hashtagPolicy: 'none' }) } });
    const few = await generated({ brand: { ...brand, voice: voice({ hashtagPolicy: 'few' }) } });

    expect(none.every((variant) => variant.hashtags.length === 0)).toBe(true);
    expect(few.map((variant) => variant.hashtags.length)).toEqual([2, 2, 2, 2]);
  });

  it('puts a link of the brief into the first comment where the platform has one', async () => {
    const variants = await generated({ brief: `${BRIEF} Anmeldung: https://example.com/koeln` });

    expect(variants.map((variant) => variant.firstComment)).toEqual([
      'Mehr dazu: https://example.com/koeln',
      null,
      'Mehr dazu: https://example.com/koeln',
      'Mehr dazu: https://example.com/koeln',
    ]);
    expect(variants.every((variant) => !variant.text.includes('https://'))).toBe(true);
  });

  it('warns about numbers from the brief and writes alt texts for described media', async () => {
    const [variant] = await generated({
      brief: 'Unser Team wächst auf 25 Personen.',
      mediaDescriptions: ['Das Team vor dem neuen Büro', 'Ein Blick in die Küche!'],
    });

    expect(variant?.warnings).toEqual(['Zahlen aus dem Briefing brauchen eine Quelle.']);
    expect(variant?.altTexts).toEqual(['Das Team vor dem neuen Büro.', 'Ein Blick in die Küche!']);
  });

  it('falls back to a general topic for a brief without text and never echoes markers', async () => {
    const [variant] = await generated({ brief: '  [mock:unknown]  ' });

    expect(variant?.hook).toBe('Unser Thema der Woche: Worauf es jetzt ankommt.');
    expect(variant?.text).not.toContain('[mock:');
  });
});

describe('MockAiProvider failure paths', () => {
  it('[mock:refusal] streams a part of the answer, then refuses', async () => {
    const events = await generate({ brief: `[mock:refusal] ${BRIEF}` });
    const { failure, report } = lastOf(events, 'failed');

    expect(types(events)).toEqual(['partial', 'failed']);
    expect(failure).toMatchObject({ code: 'REFUSED', retryable: false, refusalCategory: 'general_harms' });
    expect(report).toMatchObject({ stopReason: 'refusal', refusalCategory: 'general_harms' });
    expect(report.attempts).toHaveLength(1);
  });

  it('[mock:truncated] resets after the first cut-off and fails after the second', async () => {
    const events = await generate({ brief: `${BRIEF} [mock:truncated]` });
    const { failure, report } = lastOf(events, 'failed');

    expect(types(events)).toEqual(['partial', 'reset', 'partial', 'failed']);
    expect(failure.code).toBe('TRUNCATED');
    expect(report.stopReason).toBe('max_tokens');
    expect(report.attempts.map((attempt) => attempt.kind)).toEqual(['message', 'message']);
  });

  it('[mock:retry] resets after the cut-off and completes on the retry', async () => {
    const events = await generate({ brief: `${BRIEF} [mock:retry]` });

    expect(types(events)).toEqual(['partial', 'reset', 'partial', 'completed']);
    expect(lastOf(events, 'completed').variants).toEqual(await generated());
    expect(lastOf(events, 'completed').report.attempts).toHaveLength(2);
  });

  it('[mock:invalid] streams the answer, then fails validation', async () => {
    const events = await generate({ brief: `${BRIEF} [mock:invalid]` });

    expect(types(events)).toEqual(['partial', 'failed']);
    expect(lastOf(events, 'failed').failure).toMatchObject({ code: 'INVALID_OUTPUT', retryable: false });
  });

  it('[mock:error] fails like an overloaded API, without output', async () => {
    const events = await generate({ brief: `${BRIEF} [mock:error]` });
    const { failure, report } = lastOf(events, 'failed');

    expect(types(events)).toEqual(['failed']);
    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true, status: 529 });
    expect(report).toMatchObject({ modelServed: null, attempts: [] });
  });

  it('[mock:fallback] completes with the fallback model and reports both attempts', async () => {
    const events = await generate({ brief: `${BRIEF} [mock:fallback]` });
    const { variants, report } = lastOf(events, 'completed');

    expect(variants).toEqual(await generated());
    expect(report.modelServed).toBe('claude-opus-5');
    expect(report.attempts.map((attempt) => [attempt.kind, attempt.model])).toEqual([
      ['message', 'claude-opus-5-5'],
      ['fallback_message', 'claude-opus-5'],
    ]);
  });

  it('[mock:too-long] goes over the limit of every platform; "shorter" fits it again', async () => {
    const provider = mock();
    const variants = await generated({ brief: `${BRIEF} [mock:too-long]` });

    for (const variant of variants) {
      expect(lengthOf(variant).overLimit, variant.platform).toBe(true);
      const events = await collect(
        provider.refineVariant(
          refineInput('shorter', variant, { target: { key: variant.targetKey, platform: variant.platform } }),
          { effort: 'low' },
        ),
      );
      const [shorter] = lastOf(events, 'completed').variants;
      expect(shorter && lengthOf(shorter).overLimit, variant.platform).toBe(false);
    }
  });

  it('[mock:slow] pauses longer between the chunks', async () => {
    const config = { chunkDelayMs: 0, slowChunkDelayMs: 10, chunks: 5 };
    const fast = lastOf(await generate({}, config), 'completed');
    const slow = lastOf(await generate({ brief: `${BRIEF} [mock:slow]` }, config), 'completed');

    expect(slow.report.latencyMs).toBeGreaterThanOrEqual(45);
    expect(slow.variants).toEqual(fast.variants);
  });

  it('stops with CANCELED when the client aborts, and reports the output so far', async () => {
    const controller = new AbortController();
    const events: VariantStreamEvent[] = [];
    for await (const event of mock({ chunkDelayMs: 1 }).generateVariants(generateInput(), {
      effort: 'medium',
      signal: controller.signal,
    })) {
      events.push(event);
      if (events.length === 3) {
        controller.abort();
      }
    }
    const { failure, report } = lastOf(events, 'failed');

    expect(events).toHaveLength(4);
    expect(failure).toMatchObject({ code: 'CANCELED', retryable: false });
    expect(report.modelServed).toBeNull();
    expect(report.attempts[0]?.outputTokens).toBeGreaterThan(0);
  });

  it('cancels at once when the signal aborted before the call', async () => {
    const events = await collect(
      mock().generateVariants(generateInput(), { effort: 'medium', signal: AbortSignal.abort() }),
    );

    expect(types(events)).toEqual(['failed']);
    expect(lastOf(events, 'failed').failure.code).toBe('CANCELED');
  });
});

function refineInput(
  action: RefineAction,
  variant: Pick<GeneratedVariant, 'text' | 'hashtags' | 'firstComment'>,
  overrides: Partial<RefineVariantInput> = {},
): RefineVariantInput {
  return {
    brand,
    styleKey: 'professional',
    target: { key: 't1', platform: 'LINKEDIN' },
    language: 'de',
    action,
    instruction: null,
    variant: { text: variant.text, hashtags: variant.hashtags, firstComment: variant.firstComment },
    ...overrides,
  };
}

async function refine(
  action: RefineAction,
  variant: Pick<GeneratedVariant, 'text' | 'hashtags' | 'firstComment'>,
  overrides: Partial<RefineVariantInput> = {},
): Promise<GeneratedVariant> {
  const events = await collect(
    mock().refineVariant(refineInput(action, variant, overrides), { effort: 'low' }),
  );
  const [refined] = lastOf(events, 'completed').variants;
  if (!refined) {
    throw new Error('no variant');
  }
  return refined;
}

describe('MockAiProvider.refineVariant', () => {
  const original = async (): Promise<GeneratedVariant> => {
    const [linkedin] = await generated({ brief: `${BRIEF} https://example.com/koeln` });
    if (!linkedin) {
      throw new Error('no variant');
    }
    return linkedin;
  };

  it('makes the text shorter and keeps the opening and the call to action', async () => {
    const variant = await original();
    const shorter = await refine('shorter', variant);
    const shortest = await refine('shorter', shorter);
    const shorterStill = await refine('shorter', shortest);

    const paragraphs = variant.text.split('\n\n');
    expect(shorter.text).toBe([paragraphs[0], paragraphs.at(-1)].join('\n\n'));
    expect(shorter.callToAction).toBe(variant.callToAction);
    expect(shortest.text).toBe(paragraphs[0]);
    expect(shorterStill.text.length).toBeLessThan(shortest.text.length);
    expect(shorter.hashtags).toEqual(variant.hashtags);
    expect(shorter.firstComment).toBe(variant.firstComment);
  });

  it('makes the text longer before the call to action, without repeating itself', async () => {
    const variant = await original();
    const longer = await refine('longer', variant);
    const longest = await refine('longer', longer);

    expect(longer.text.length).toBeGreaterThan(variant.text.length);
    expect(longer.text.split('\n\n').at(-1)).toBe(variant.callToAction);
    expect(longest.text.length).toBeGreaterThan(longer.text.length);
    expect(await refine('longer', longest)).toEqual(longest);
  });

  it('changes the tone through the opening and replaces an earlier tone', async () => {
    const variant = await original();
    const formal = await refine('more_formal', variant);
    const casual = await refine('more_casual', formal);
    const hook = await refine('stronger_hook', casual);

    expect(formal.text).toBe(`Kurz eingeordnet: ${variant.text}`);
    expect(casual.text).toBe(`Mal ehrlich: ${variant.text}`);
    expect(hook.hook).toBe(`Das unterschätzen die meisten: ${variant.hook}`);
  });

  it('adds a call to action once', async () => {
    const variant = { text: 'Ein Satz ohne Aufforderung.', hashtags: [], firstComment: null };
    const withCta = await refine('add_cta', variant);

    expect(withCta.text).toBe(
      'Ein Satz ohne Aufforderung.\n\nWas ist Ihre Erfahrung? Schreiben Sie uns, wir antworten gern.',
    );
    expect(withCta.callToAction).toBe('Was ist Ihre Erfahrung? Schreiben Sie uns, wir antworten gern.');
    expect(await refine('add_cta', withCta)).toEqual(withCta);
  });

  it('removes emoji but keeps the legal signs', async () => {
    const text =
      'Neu \u{1F680} im Team \u{1F469}\u{1F3FD}\u200D\u{1F4BB} und \u2764\uFE0F \u{1F1E9}\u{1F1EA}\n\nAcme\u00AE';
    const refined = await refine('fewer_emojis', { text, hashtags: [], firstComment: null });

    expect(refined.text).toBe('Neu im Team und\n\nAcme\u00AE');
  });

  it('translates a mock text into the other language and relabels the first comment', async () => {
    const variant = await original();
    const english = await refine('translate', variant, { language: 'en' });

    expect(english.hook).toBe(`${TOPIC}: what matters now.`);
    expect(english.callToAction).toBe('How do you approach this? We would love to hear your view.');
    expect(english.hashtags).toEqual(['Strategy', 'Execution', 'Leadership']);
    expect(english.firstComment).toBe('Read more: https://example.com/koeln');
  });

  it('rewrites for another platform within its limit and drops what it does not support', async () => {
    const variant = await original();
    const x = await refine('rewrite_for_platform', variant, { target: { key: 't1', platform: 'X' } });

    expect(x.platform).toBe('X');
    expect(lengthOf(x).overLimit).toBe(false);
    expect(x.hashtags).toHaveLength(2);
    expect(x.firstComment).toBeNull();
  });

  it('applies a custom instruction before the call to action', async () => {
    const variant = await original();
    const custom = await refine('custom', variant, { instruction: 'Bitte  mit Bezug\nzum Standort' });

    expect(custom.text.split('\n\n').at(-2)).toBe(
      'Überarbeitet nach Ihrer Anweisung: Bitte mit Bezug zum Standort.',
    );
    expect(custom.callToAction).toBe(variant.callToAction);
  });

  it('reaches the failure paths through markers in the text or the instruction', async () => {
    const provider = mock();
    const variant = await original();
    const run = (overrides: Partial<RefineVariantInput>) =>
      collect(provider.refineVariant(refineInput('custom', variant, overrides), { effort: 'low' }));

    const fromInstruction = await run({ instruction: '[mock:refusal] kürzer' });
    const fromText = await run({
      variant: { ...variant, text: `${variant.text} [mock:error]` },
      instruction: 'kürzer',
    });

    expect(lastOf(fromInstruction, 'failed').failure.code).toBe('REFUSED');
    expect(lastOf(fromText, 'failed').failure.code).toBe('PROVIDER_ERROR');
  });
});

describe('MockAiProvider.suggestTopics', () => {
  const topicsInput = (overrides: Partial<SuggestTopicsInput> = {}): SuggestTopicsInput => ({
    brand,
    language: 'de',
    count: 10,
    recentPosts: [],
    topPosts: [],
    discardedIdeas: [],
    upcomingDates: [],
    ...overrides,
  });

  it('suggests valid ideas deterministically, with the content pillars in turn', async () => {
    const provider = mock();
    const result = await provider.suggestTopics(topicsInput(), { effort: 'medium' });
    if (!result.ok) {
      throw new Error(result.failure.detail);
    }

    expect(topicIdeasOutputSchema.parse({ ideas: result.value }).ideas).toHaveLength(10);
    expect(result.value.slice(0, 3).map((idea) => idea.pillar)).toEqual(['Produkt', 'Team', 'Produkt']);
    expect(result.value[0]?.basedOn).toEqual(['Content-Säule']);
    expect(result.report).toMatchObject({
      provider: 'mock',
      modelServed: 'claude-opus-5-5',
      effort: 'medium',
    });
    expect(await provider.suggestTopics(topicsInput(), { effort: 'medium' })).toMatchObject({
      value: result.value,
    });
  });

  it('starts with upcoming dates, leaves out discarded ideas and keeps to the count', async () => {
    const result = await mock().suggestTopics(
      topicsInput({
        language: 'en',
        count: 3,
        discardedIdeas: ['three questions customers ask us most'],
        upcomingDates: [{ date: '2026-12-24', label: 'Christmas Eve' }],
        brand: { ...brand, profile: { ...brand.profile, contentPillars: [] } },
      }),
      { effort: 'medium' },
    );

    expect(result.ok && result.value).toEqual([
      expect.objectContaining({
        title: 'Christmas Eve: our take on the occasion',
        whyNow: 'Christmas Eve is on 2026-12-24.',
        basedOn: ['Christmas Eve'],
      }),
      expect.objectContaining({
        title: 'A look behind the scenes',
        pillar: null,
        basedOn: ['company profile'],
      }),
      expect.objectContaining({ title: 'The most common misconception in our industry' }),
    ]);
  });

  it('cancels when the client aborts', async () => {
    const result = await mock().suggestTopics(topicsInput(), {
      effort: 'medium',
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ ok: false, failure: { code: 'CANCELED' } });
  });
});

describe('MockAiProvider.suggestAltText', () => {
  it.each<[ContentLanguage, string | null, string]>([
    ['de', 'Neues Büro in Köln', 'Eine ruhige, klar aufgebaute Szene zum Thema Neues Büro in Köln.'],
    ['en', null, 'A calm, clearly composed scene with one recognizable subject in the center.'],
  ])('describes the image in %s', async (language, context, expected) => {
    const result = await mock().suggestAltText(
      { language, context, image: { kind: 'url', url: 'https://example.com/image.jpg' } },
      { effort: 'low' },
    );
    if (!result.ok) {
      throw new Error(result.failure.detail);
    }

    expect(altTextOutputSchema.parse({ altText: result.value }).altText).toBe(expected);
    expect(result.report.attempts[0]?.inputTokens).toBeGreaterThan(1600);
  });
});
