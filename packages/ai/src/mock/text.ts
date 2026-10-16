import { countGraphemes } from '@smp/platform-rules';

// Text helpers of the MockAiProvider: triggers, topics, paragraphs and cutting at word boundaries.

/**
 * Markers in a brief (or, for a refinement, in the text or instruction) that select a path of the
 * mock (guide step 2.5). Unknown markers are ignored; all markers are removed from the output.
 */
export const MOCK_TRIGGERS = [
  'refusal',
  'truncated',
  'retry',
  'invalid',
  'error',
  'fallback',
  'slow',
  'too-long',
] as const;
export type MockTrigger = (typeof MOCK_TRIGGERS)[number];

const MARKER = /\[mock:([a-z-]+)\]/g;
const URLS = /https?:\/\/[^\s<>"]+/g;

const isTrigger = (name: string): name is MockTrigger => (MOCK_TRIGGERS as readonly string[]).includes(name);

export function triggersOf(text: string): ReadonlySet<MockTrigger> {
  const found = new Set<MockTrigger>();
  for (const match of text.matchAll(MARKER)) {
    const name = match[1] ?? '';
    if (isTrigger(name)) {
      found.add(name);
    }
  }
  return found;
}

export const stripMarkers = (text: string): string => text.replace(MARKER, ' ');

export const firstUrl = (text: string): string | null => text.match(URLS)?.[0] ?? null;

/** The text on one line with single spaces. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** At most `max` graphemes, cut at a word boundary and marked with "..." when cut. */
export function clip(text: string, max: number): string {
  if (countGraphemes(text) <= max) {
    return text;
  }
  const kept = [...graphemes.segment(text)]
    .slice(0, Math.max(max - 3, 1))
    .map((part) => part.segment)
    .join('');
  const space = kept.lastIndexOf(' ');
  return `${(space > 0 ? kept.slice(0, space) : kept).trimEnd()}...`;
}

export const paragraphsOf = (text: string): string[] =>
  text
    .split(/\n[^\S\n]*\n\s*/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

export const joinParagraphs = (paragraphs: readonly string[]): string => paragraphs.join('\n\n');

/** The text with closing punctuation. */
export const asSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

export const sentencesOf = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0);

const TOPIC_MAX = 80;

/** The topic of a brief: its first sentence without markers, links and closing punctuation. */
export function topicOf(text: string, fallback: string): string {
  const firstLine =
    stripMarkers(text)
      .replace(URLS, ' ')
      .split('\n')
      .map(oneLine)
      .find((line) => line.length > 0) ?? '';
  const topic = (sentencesOf(firstLine)[0] ?? '').replace(/[\s.!?:;,]+$/u, '');
  return topic.length > 0 ? clip(topic, TOPIC_MAX) : fallback;
}

/** Whether the brief, without markers and links, contains a digit. */
export const mentionsNumbers = (text: string): boolean =>
  /\p{Nd}/u.test(stripMarkers(text).replace(URLS, ' '));

// Emoji with their modifiers, joined sequences and flags. The legal signs stay, as in the emoji
// check of the repository.
const EMOJI =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F|\u20E3|\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator}))*/gu;
const LEGAL_SIGNS = new Set(['\u00A9', '\u00AE', '\u2122']);

export const stripEmojis = (text: string): string =>
  text
    .replace(EMOJI, (match) => (LEGAL_SIGNS.has(match) ? match : ''))
    .replace(/\uFE0F|\u20E3/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/^[^\S\n]+/gm, '');
