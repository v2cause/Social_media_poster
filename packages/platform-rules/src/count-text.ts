import twitterText from 'twitter-text';

import { capabilitiesOf } from './capabilities';
import type { Platform } from './platforms';

// Character counting as the platforms count (guide step 2.2). The server computes the counts;
// the composer shows the same numbers live, because both use this package.

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** User-perceived characters of the NFC-normalized text. */
export function countGraphemes(text: string): number {
  let count = 0;
  for (const segment of graphemes.segment(text.normalize('NFC'))) {
    if (segment.segment.length > 0) {
      count += 1;
    }
  }
  return count;
}

/** The weighted length X counts against its limit (URLs 23, emoji 2, CJK 2). */
export function xWeightedLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}

/** Hashtags without the leading "#", as the variant stores them. */
const normalizeTag = (tag: string): string => tag.trim().replace(/^#+/, '');

/**
 * The text as it will be published: the body, then the hashtags in one line after a blank line.
 * Hashtags that already appear in the body are not repeated.
 */
export function composePostText(text: string, hashtags: readonly string[] = []): string {
  const body = text.trim();
  const present = new Set(extractHashtags(body).map((tag) => tag.toLowerCase()));
  const tags = hashtags
    .map(normalizeTag)
    .filter((tag) => tag.length > 0 && !present.has(tag.toLowerCase()))
    .filter(
      (tag, index, all) => all.findIndex((other) => other.toLowerCase() === tag.toLowerCase()) === index,
    );
  if (tags.length === 0) {
    return body;
  }
  const line = tags.map((tag) => `#${tag}`).join(' ');
  return body.length > 0 ? `${body}\n\n${line}` : line;
}

// A hashtag or mention starts after a non-word character; letters, digits, marks and the
// underscore form its name.
const HASHTAG = /(?:^|[^\p{L}\p{N}\p{M}_&])#([\p{L}\p{N}\p{M}_]*[\p{L}\p{M}_][\p{L}\p{N}\p{M}_]*)/gu;
const MENTION = /(?:^|[^\p{L}\p{N}\p{M}_@])@([A-Za-z0-9_.]+)/gu;

/** The hashtags of a text, without "#". */
export function extractHashtags(text: string): string[] {
  return [...text.normalize('NFC').matchAll(HASHTAG)].map((match) => match[1] ?? '');
}

/** The @ mentions of a text, without "@". */
export function extractMentions(text: string): string[] {
  return [...text.normalize('NFC').matchAll(MENTION)].map((match) => match[1] ?? '');
}

export interface TextCount {
  length: number;
  max: number;
  remaining: number;
  overLimit: boolean;
  /** Length beyond which the feed folds the text, if the platform has such a hint. */
  recommendedLength?: number;
}

/** Counts the text as the platform does and compares it with its limit. */
export function countText(platform: Platform, text: string): TextCount {
  const rules = capabilitiesOf(platform).text;
  const length = rules.counting === 'x-weighted' ? xWeightedLength(text) : countGraphemes(text);
  return {
    length,
    max: rules.maxLength,
    remaining: rules.maxLength - length,
    overLimit: length > rules.maxLength,
    ...(rules.recommendedLength === undefined ? {} : { recommendedLength: rules.recommendedLength }),
  };
}
