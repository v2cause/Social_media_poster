import type { BrandContext, BrandVoiceContent } from '@smp/core';

import { dataText } from './escape';

// Layer 2 of the prompt (architecture 5.2): company profile, brand voice and the company's own
// styles. Cached with the second breakpoint, so it must render byte for byte the same for the
// same input: keys in alphabetical order, styles sorted by key, no timestamps, no ids.

const oneLine = (value: string): string => dataText(value).replace(/\s*\n\s*/g, ' ');

function field(key: string, value: string | null | undefined): string[] {
  const text = value ? oneLine(value) : '';
  return text ? [`${key}: ${text}`] : [];
}

function list(key: string, values: readonly string[]): string[] {
  const items = values.map(oneLine).filter((item) => item.length > 0);
  return items.length > 0 ? [`${key}:`, ...items.map((item) => `- ${item}`)] : [];
}

const section = (tag: string, lines: string[]): string[] =>
  lines.length > 0 ? [`<${tag}>`, ...lines, `</${tag}>`] : [];

function voiceSection(voice: BrandVoiceContent): string[] {
  const examples = voice.examplePosts
    .map((post) => dataText(post))
    .filter((post) => post.length > 0)
    .flatMap((post) => ['<example_post>', post, '</example_post>']);
  return [
    ...section('brand_voice', [
      ...field('description', voice.description),
      ...list('dos', voice.dos),
      ...list('donts', voice.donts),
      ...field('emoji_policy', voice.emojiPolicy),
      ...list('forbidden_words', voice.forbiddenWords),
      ...field('hashtag_policy', voice.hashtagPolicy),
      ...field('language', voice.language),
      ...field('name', voice.name),
      ...list('tone', voice.tone),
      ...list('vocabulary', voice.vocabulary),
    ]),
    ...section('example_posts', examples),
  ];
}

export function renderBrandContext(context: BrandContext): string {
  const { profile } = context;
  const styles = [...context.customStyles]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .flatMap((style) => [
      `<style key="${dataText(style.key)}">`,
      ...field('name', style.name),
      'instructions:',
      dataText(style.instructions),
      '</style>',
    ]);
  const lines = [
    '<brand_context>',
    ...section('company', [
      ...list('content_pillars', profile.contentPillars),
      ...field('goals', profile.goals),
      ...field('industry', profile.industry),
      ...field('name', profile.name),
      ...field('target_audience', profile.targetAudience),
    ]),
    ...(context.voice ? voiceSection(context.voice) : []),
    ...section('custom_styles', styles),
    '</brand_context>',
  ];
  return `${lines.join('\n')}\n`;
}
