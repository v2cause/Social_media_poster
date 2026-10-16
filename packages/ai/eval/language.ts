import type { ContentLanguage } from '@smp/core';

// A small language check for the eval suite (guide step 2.10): frequent function words of German
// and English, without the words both languages share ("in", "an", "so", "was", "will").

const FUNCTION_WORDS: Readonly<Record<ContentLanguage, ReadonlySet<string>>> = {
  de: new Set([
    'und',
    'der',
    'die',
    'das',
    'ist',
    'nicht',
    'mit',
    'für',
    'wir',
    'sie',
    'ein',
    'eine',
    'auf',
    'zu',
    'den',
    'dem',
    'des',
    'im',
    'auch',
    'sich',
    'es',
    'von',
    'bei',
    'wie',
    'oder',
    'aber',
    'unser',
    'unsere',
    'ihr',
    'ihre',
    'ihnen',
    'jede',
    'jeden',
    'noch',
    'nur',
    'sind',
    'wird',
  ]),
  en: new Set([
    'the',
    'and',
    'is',
    'of',
    'to',
    'we',
    'you',
    'for',
    'with',
    'not',
    'a',
    'on',
    'our',
    'your',
    'it',
    'this',
    'that',
    'are',
    'be',
    'at',
    'as',
    'or',
    'but',
    'how',
    'what',
    'every',
    'they',
    'their',
    'from',
    'by',
    'have',
    'has',
  ]),
};

/** At least this many function words, and twice as many as of the other language. */
const MIN_HITS = 3;

export function detectLanguage(text: string): ContentLanguage | 'unknown' {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const hits = (language: ContentLanguage): number =>
    words.filter((word) => FUNCTION_WORDS[language].has(word)).length;
  const de = hits('de');
  const en = hits('en');
  if (de >= MIN_HITS && de >= 2 * en) {
    return 'de';
  }
  if (en >= MIN_HITS && en >= 2 * de) {
    return 'en';
  }
  return 'unknown';
}
