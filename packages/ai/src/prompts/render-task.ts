import type {
  GenerateVariantsInput,
  RefineAction,
  RefineVariantInput,
  SuggestAltTextInput,
  SuggestTopicsInput,
} from '@smp/core';

import { dataText } from './escape';

// Layer 3 of the prompt (architecture 5.2): the task. Not cached; varies with every call.

const REFINE_ACTION_TEXT: Readonly<Record<RefineAction, string>> = {
  shorter: 'Make the post clearly shorter. Keep its core message, the hook and the call to action.',
  longer: 'Make the post longer with substance from the brief, not with filler.',
  more_formal: 'Make the tone more formal and businesslike.',
  more_casual: 'Make the tone more casual and conversational.',
  stronger_hook: 'Rewrite the opening so it grabs the target audience at once. Keep the rest.',
  add_cta: 'Add one clear call to action that fits the post.',
  fewer_emojis: 'Use fewer emoji, or none where they do not add meaning.',
  translate: 'Translate the post into the language of the task. Keep meaning, tone and structure.',
  rewrite_for_platform: 'Rewrite the post for the platform of the target, following its rules.',
  custom: 'Apply the request in <instruction>.',
};

const block = (tag: string, text: string): string[] => [`<${tag}>`, dataText(text), `</${tag}>`];

const join = (lines: string[]): string => `${lines.join('\n')}\n`;

export function renderGenerateTask(input: GenerateVariantsInput): string {
  return join([
    '<task>',
    'type: generate_variants',
    `style: ${dataText(input.styleKey)}`,
    `language: ${input.language}`,
    'targets:',
    ...input.targets.map((target) => `- ${target.key}: ${target.platform}`),
    ...(input.mediaDescriptions.length > 0
      ? [
          'media:',
          ...input.mediaDescriptions.map((text, index) => `- m${String(index + 1)}: ${dataText(text)}`),
        ]
      : []),
    '</task>',
    ...block('brief', input.brief),
  ]);
}

export function renderRefineTask(input: RefineVariantInput): string {
  const { variant } = input;
  return join([
    '<task>',
    'type: refine_variant',
    `style: ${dataText(input.styleKey)}`,
    `language: ${input.language}`,
    'targets:',
    `- ${input.target.key}: ${input.target.platform}`,
    `action: ${input.action}`,
    `action_description: ${REFINE_ACTION_TEXT[input.action]}`,
    'Return the refined variant as the only element of variants.',
    '</task>',
    '<current_variant>',
    'text:',
    dataText(variant.text),
    ...(variant.hashtags.length > 0 ? [`hashtags: ${variant.hashtags.map(dataText).join(', ')}`] : []),
    ...(variant.firstComment ? ['first_comment:', dataText(variant.firstComment)] : []),
    '</current_variant>',
    ...(input.action === 'custom' && input.instruction ? block('instruction', input.instruction) : []),
  ]);
}

export function renderTopicsTask(input: SuggestTopicsInput): string {
  const posts = (tag: string, item: string, values: readonly string[]): string[] =>
    values.length > 0 ? [`<${tag}>`, ...values.flatMap((value) => block(item, value)), `</${tag}>`] : [];
  return join([
    '<task>',
    'type: suggest_ideas',
    `language: ${input.language}`,
    `count: ${String(input.count)}`,
    'fields:',
    '- title: a short working title',
    '- angle: the specific take of the post',
    '- pillar: the content pillar it belongs to, or null',
    '- whyNow: why the topic fits now',
    '- basedOn: what inspired it, for example "content pillar", "top post" or the label of an upcoming date',
    '- suggestedPlatforms: the platforms where it works best',
    '- suggestedStyleKey: the key of a style from the catalog or the custom styles, or null',
    '- format: for example "text post", "carousel", "image post", "short video" or "poll"',
    'Avoid topics that repeat the past posts or resemble the discarded ideas.',
    '</task>',
    ...posts('past_posts', 'post', input.recentPosts),
    ...posts('top_posts', 'post', input.topPosts),
    ...posts('discarded_ideas', 'idea', input.discardedIdeas),
    ...(input.upcomingDates.length > 0
      ? [
          '<upcoming_dates>',
          ...input.upcomingDates.map((date) => `- ${dataText(date.date)}: ${dataText(date.label)}`),
          '</upcoming_dates>',
        ]
      : []),
  ]);
}

export function renderAltTextTask(input: SuggestAltTextInput): string {
  return join([
    '<task>',
    'type: alt_text',
    `language: ${input.language}`,
    'fields:',
    '- altText: one or two sentences, at most 250 characters, that describe what matters in the image for people who cannot see it. No "image of" or "picture of".',
    '</task>',
    ...(input.context ? block('post_context', input.context) : []),
  ]);
}
