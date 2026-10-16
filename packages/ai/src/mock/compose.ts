import type {
  AiTarget,
  ContentLanguage,
  GeneratedVariant,
  GenerateVariantsInput,
  HashtagPolicy,
  RefineAction,
  RefineVariantInput,
  SuggestAltTextInput,
  SuggestTopicsInput,
  TopicIdea,
} from '@smp/core';
import {
  capabilitiesOf,
  composePostText,
  countGraphemes,
  countText,
  type Platform,
} from '@smp/platform-rules';

import { allFixtures, fill, fixtureOf, styleOf, type MockStyle } from './fixtures';
import {
  asSentence,
  clip,
  firstUrl,
  joinParagraphs,
  mentionsNumbers,
  oneLine,
  paragraphsOf,
  sentencesOf,
  stripEmojis,
  stripMarkers,
  topicOf,
} from './text';

// The deterministic answers of the MockAiProvider (guide step 2.5): the same input always gives
// the same output. Texts come from the fixtures per language and style, shaped per platform, and
// fit the platform limits like the model's answers should.

const HASHTAGS: Readonly<Record<Platform, number>> = { LINKEDIN: 3, INSTAGRAM: 5, FACEBOOK: 2, X: 2 };
const BODY_PARAGRAPHS: Readonly<Record<Platform, number>> = { LINKEDIN: 2, INSTAGRAM: 2, FACEBOOK: 1, X: 0 };

const lengthOf = (platform: Platform, paragraphs: readonly string[], hashtags: readonly string[]): number =>
  countText(platform, composePostText(joinParagraphs(paragraphs), hashtags)).length;

const fits = (platform: Platform, paragraphs: readonly string[], hashtags: readonly string[]): boolean =>
  lengthOf(platform, paragraphs, hashtags) <= capabilitiesOf(platform).text.maxLength;

/** Drops body paragraphs from the end, then the closing paragraph, then shortens the opening. */
function fit(platform: Platform, paragraphs: readonly string[], hashtags: readonly string[]): string[] {
  const kept = [...paragraphs];
  while (kept.length > 1 && !fits(platform, kept, hashtags)) {
    kept.splice(kept.length > 2 ? kept.length - 2 : 1, 1);
  }
  let [opening = ''] = kept;
  while (!fits(platform, [opening], hashtags) && countGraphemes(opening) > 10) {
    opening = clip(opening, countGraphemes(opening) - 10);
  }
  return kept.length > 1 ? kept : [opening];
}

/** Repeats the body until the post is over the limit, for the [mock:too-long] path. */
function overLimit(
  platform: Platform,
  style: MockStyle,
  opening: string,
  hashtags: readonly string[],
): string[] {
  const max = capabilitiesOf(platform).text.maxLength;
  const build = (rounds: number): string[] => [
    opening,
    ...Array.from({ length: rounds }, () => style.paragraphs).flat(),
    style.callToAction,
  ];
  const unit = countGraphemes(joinParagraphs(style.paragraphs)) + 2;
  let rounds = Math.max(1, Math.ceil((max - lengthOf(platform, build(0), hashtags)) / unit));
  while (fits(platform, build(rounds), hashtags)) {
    rounds += 1;
  }
  return build(rounds);
}

function hashtagsFor(style: MockStyle, platform: Platform, policy: HashtagPolicy, wanted?: number): string[] {
  const byPolicy = { none: 0, few: Math.min(2, HASHTAGS[platform]), normal: HASHTAGS[platform] }[policy];
  const count = Math.min(
    wanted ?? byPolicy,
    capabilitiesOf(platform).hashtags.max ?? Number.MAX_SAFE_INTEGER,
  );
  return style.hashtags.slice(0, count);
}

const firstCommentFor = (platform: Platform, comment: string | null): string | null =>
  capabilitiesOf(platform).firstComment ? comment : null;

const KNOWN_CALLS_TO_ACTION = new Set(
  allFixtures().flatMap((fixture) => [
    ...Object.values(fixture.styles).map((style) => style.callToAction),
    fixture.customStyle.callToAction,
    fixture.refine.addCallToAction,
  ]),
);

function variantOf(
  target: AiTarget,
  paragraphs: readonly string[],
  fields: Pick<GeneratedVariant, 'hashtags' | 'firstComment' | 'altTexts' | 'warnings'>,
): GeneratedVariant {
  const closing = paragraphs.length > 1 ? paragraphs.at(-1) : undefined;
  return {
    targetKey: target.key,
    platform: target.platform,
    hook: sentencesOf(paragraphs[0] ?? '')[0] ?? '',
    text: joinParagraphs(paragraphs),
    callToAction: closing !== undefined && KNOWN_CALLS_TO_ACTION.has(closing) ? closing : null,
    ...fields,
    firstComment: firstCommentFor(target.platform, fields.firstComment),
  };
}

interface ComposeOptions {
  language: ContentLanguage;
  styleKey: string;
  target: AiTarget;
  topic: string;
  hashtagPolicy: HashtagPolicy;
  /** How many hashtags, instead of the number the policy gives. */
  hashtagCount?: number;
  firstComment: string | null;
  altTexts: string[];
  warnings: string[];
  tooLong: boolean;
}

function compose(options: ComposeOptions): GeneratedVariant {
  const { platform } = options.target;
  const style = styleOf(options.language, options.styleKey);
  const opening = fill(style.hook, { topic: options.topic });
  const hashtags = hashtagsFor(style, platform, options.hashtagPolicy, options.hashtagCount);
  const paragraphs = options.tooLong
    ? overLimit(platform, style, opening, hashtags)
    : fit(
        platform,
        [opening, ...style.paragraphs.slice(0, BODY_PARAGRAPHS[platform]), style.callToAction],
        hashtags,
      );
  return variantOf(options.target, paragraphs, {
    hashtags,
    firstComment: options.firstComment,
    altTexts: options.altTexts,
    warnings: options.warnings,
  });
}

/** The alt text of a described media item: one sentence. */
const altTextOf = (description: string): string => asSentence(clip(oneLine(stripMarkers(description)), 200));

export function composeVariants(input: GenerateVariantsInput, tooLong: boolean): GeneratedVariant[] {
  const fixture = fixtureOf(input.language);
  const topic = topicOf(input.brief, fixture.fallbackTopic);
  const url = firstUrl(input.brief);
  return input.targets.map((target) =>
    compose({
      language: input.language,
      styleKey: input.styleKey,
      target,
      topic,
      hashtagPolicy: input.brand.voice?.hashtagPolicy ?? 'normal',
      firstComment: url ? `${fixture.firstCommentLabel} ${url}` : null,
      altTexts: input.mediaDescriptions.map(altTextOf),
      warnings: mentionsNumbers(input.brief) ? [fixture.numberWarning] : [],
      tooLong,
    }),
  );
}

// Round trips: a refinement of a mock text finds the topic again, whatever the language or style
// of the text, so translating or rewriting does not nest the templates.
const LEADS = allFixtures().flatMap((fixture) => Object.values(fixture.refine.leads));
const HOOK_PATTERNS = allFixtures()
  .flatMap((fixture) => [...Object.values(fixture.styles), fixture.customStyle])
  .map((style) => {
    const [before = '', after = ''] = style.hook.split('{topic}');
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escape(before)}(.+?)${escape(after)}$`, 'u');
  });

const withoutLead = (text: string): string => {
  const lead = LEADS.find((candidate) => text.startsWith(candidate));
  return lead ? text.slice(lead.length) : text;
};

function topicOfVariant(text: string, fallback: string): string {
  const opening = withoutLead(paragraphsOf(text)[0] ?? '');
  for (const pattern of HOOK_PATTERNS) {
    const topic = pattern.exec(opening)?.[1];
    if (topic) {
      return topic;
    }
  }
  return topicOf(opening, fallback);
}

/** Relabels a first comment the mock wrote, for a translation. */
function relabel(comment: string | null, language: ContentLanguage): string | null {
  if (!comment) {
    return comment;
  }
  const label = allFixtures()
    .map((fixture) => fixture.firstCommentLabel)
    .find((candidate) => comment.startsWith(`${candidate} `));
  return label ? `${fixtureOf(language).firstCommentLabel}${comment.slice(label.length)}` : comment;
}

function shorten(paragraphs: readonly string[]): string[] {
  const [opening = '', ...rest] = paragraphs;
  const closing = rest.at(-1);
  if (paragraphs.length >= 3 && closing !== undefined) {
    return [opening, closing];
  }
  if (paragraphs.length === 2) {
    return [opening];
  }
  const sentences = sentencesOf(opening);
  if (sentences.length >= 2) {
    return [sentences.slice(0, Math.ceil(sentences.length / 2)).join(' ')];
  }
  const length = countGraphemes(opening);
  return length > 20 ? [clip(opening, Math.ceil(length * 0.6))] : [...paragraphs];
}

/** Adds a paragraph before the closing one (usually the call to action). */
const beforeClosing = (paragraphs: readonly string[], extra: string): string[] =>
  paragraphs.length >= 2
    ? [...paragraphs.slice(0, -1), extra, ...paragraphs.slice(-1)]
    : [...paragraphs, extra];

function lengthen(paragraphs: readonly string[], extras: readonly string[]): string[] {
  const extra = extras.find((candidate) => !paragraphs.includes(candidate));
  return extra === undefined ? [...paragraphs] : beforeClosing(paragraphs, extra);
}

function withLead(paragraphs: readonly string[], lead: string): string[] {
  const [opening = '', ...rest] = paragraphs;
  return [`${lead}${withoutLead(opening)}`, ...rest];
}

type TextAction = Exclude<RefineAction, 'translate' | 'rewrite_for_platform'>;

function refineParagraphs(
  action: TextAction,
  text: string,
  instruction: string | null,
  language: ContentLanguage,
): string[] {
  const { refine } = fixtureOf(language);
  const paragraphs = paragraphsOf(text);
  switch (action) {
    case 'shorter':
      return shorten(paragraphs);
    case 'longer':
      return lengthen(paragraphs, refine.longer);
    case 'more_formal':
    case 'more_casual':
    case 'stronger_hook':
      return withLead(paragraphs, refine.leads[action]);
    case 'add_cta':
      return paragraphs.includes(refine.addCallToAction)
        ? paragraphs
        : [...paragraphs, refine.addCallToAction];
    case 'fewer_emojis':
      return paragraphsOf(stripEmojis(text));
    case 'custom': {
      const request = oneLine(stripMarkers(instruction ?? ''));
      return request.length > 0
        ? beforeClosing(paragraphs, fill(refine.custom, { instruction: asSentence(clip(request, 120)) }))
        : paragraphs;
    }
  }
}

export function refineVariantText(input: RefineVariantInput): GeneratedVariant {
  const { action, language, target, variant } = input;

  if (action === 'translate' || action === 'rewrite_for_platform') {
    return compose({
      language,
      styleKey: input.styleKey,
      target,
      topic: topicOfVariant(variant.text, fixtureOf(language).fallbackTopic),
      hashtagPolicy: 'normal',
      hashtagCount: Math.min(variant.hashtags.length, HASHTAGS[target.platform]),
      firstComment: relabel(variant.firstComment, language),
      altTexts: [],
      warnings: [],
      tooLong: false,
    });
  }

  const refined = refineParagraphs(action, variant.text, input.instruction, language);
  const hashtags = variant.hashtags.slice(0, capabilitiesOf(target.platform).hashtags.max);
  return variantOf(target, fit(target.platform, refined, hashtags), {
    hashtags,
    firstComment: variant.firstComment,
    altTexts: [],
    warnings: [],
  });
}

export function composeIdeas(input: SuggestTopicsInput): TopicIdea[] {
  const fixture = fixtureOf(input.language);
  const { labels } = fixture.ideas;
  const pillars = input.brand.profile.contentPillars;
  const discarded = new Set(input.discardedIdeas.map((title) => oneLine(title).toLowerCase()));

  const fromDates = input.upcomingDates.slice(0, 2).map((upcoming): TopicIdea => {
    const { date } = fixture.ideas;
    const label = clip(oneLine(upcoming.label), 80);
    return {
      title: fill(date.title, { label }),
      angle: date.angle,
      pillar: null,
      whyNow: fill(date.whyNow, { label, date: upcoming.date }),
      basedOn: [label],
      suggestedPlatforms: date.platforms,
      suggestedStyleKey: date.styleKey,
      format: date.format,
    };
  });
  const fromFixture = fixture.ideas.items.map((item, index): TopicIdea => {
    const pillar = pillars.length > 0 ? (pillars[index % pillars.length] ?? null) : null;
    return {
      title: item.title,
      angle: item.angle,
      pillar,
      whyNow: item.whyNow,
      basedOn: [pillar === null ? labels.profile : labels.pillar],
      suggestedPlatforms: item.platforms,
      suggestedStyleKey: item.styleKey,
      format: item.format,
    };
  });
  return [...fromDates, ...fromFixture]
    .filter((idea) => !discarded.has(idea.title.toLowerCase()))
    .slice(0, Math.max(0, input.count));
}

export function composeAltText(input: SuggestAltTextInput): string {
  const { altText } = fixtureOf(input.language);
  const context = input.context ? clip(oneLine(stripMarkers(input.context)), 150) : '';
  return context.length > 0 ? fill(altText.withContext, { context }) : altText.withoutContext;
}
