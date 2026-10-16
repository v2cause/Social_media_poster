import { describe, expect, it } from 'vitest';

import {
  composePostText,
  countGraphemes,
  countText,
  extractHashtags,
  extractMentions,
  xWeightedLength,
} from '.';

// Emoji are written as escapes; the repository allows no literal emoji (guide B.1).
const GRINNING = '\u{1F600}';
const FAMILY = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
const WAVE_SKIN_TONE = '\u{1F44B}\u{1F3FD}';
const FLAG_DE = '\u{1F1E9}\u{1F1EA}';
const E_ACUTE_COMPOSED = 'é';
const E_ACUTE_DECOMPOSED = 'e\u0301';
const NI_HAO = '你好';

describe('countGraphemes', () => {
  it('counts user-perceived characters, not code units', () => {
    expect(countGraphemes('Hallo')).toBe(5);
    expect(countGraphemes(GRINNING)).toBe(1);
    expect(countGraphemes(FAMILY)).toBe(1);
    expect(countGraphemes(WAVE_SKIN_TONE)).toBe(1);
    expect(countGraphemes(FLAG_DE)).toBe(1);
    expect(FAMILY.length).toBe(11);
  });

  it('counts a combining sequence like its composed form', () => {
    expect(countGraphemes(E_ACUTE_COMPOSED)).toBe(1);
    expect(countGraphemes(E_ACUTE_DECOMPOSED)).toBe(1);
    expect(countGraphemes(`Caf${E_ACUTE_DECOMPOSED}`)).toBe(4);
  });
});

describe('xWeightedLength', () => {
  it('weighs latin characters 1, emoji 2 and CJK 2', () => {
    expect(xWeightedLength(`Hello, world! ${GRINNING}`)).toBe(16);
    expect(xWeightedLength(FAMILY)).toBe(2);
    expect(xWeightedLength(WAVE_SKIN_TONE)).toBe(2);
    expect(xWeightedLength(NI_HAO)).toBe(4);
  });

  it('counts every URL as 23 characters, with or without protocol', () => {
    expect(xWeightedLength(`https://example.com/${'a'.repeat(200)}`)).toBe(23);
    expect(xWeightedLength('Read example.com today')).toBe(5 + 23 + 6);
    expect(xWeightedLength('a https://b.de/x')).toBe(2 + 23);
    // Only known top-level domains make a URL; twitter-text ships the list.
    expect(xWeightedLength('a b.example')).toBe(11);
  });

  it('counts on NFC-normalized text', () => {
    expect(xWeightedLength(E_ACUTE_DECOMPOSED)).toBe(xWeightedLength(E_ACUTE_COMPOSED));
  });
});

describe('countText', () => {
  it('compares the X weighted length with 280', () => {
    expect(countText('X', 'a'.repeat(280))).toMatchObject({
      length: 280,
      max: 280,
      overLimit: false,
      remaining: 0,
    });
    expect(countText('X', 'a'.repeat(281))).toMatchObject({ length: 281, overLimit: true, remaining: -1 });
    expect(countText('X', NI_HAO.repeat(70))).toMatchObject({ length: 280, overLimit: false });
    expect(countText('X', `${NI_HAO.repeat(70)}a`)).toMatchObject({ length: 281, overLimit: true });
    expect(countText('X', GRINNING.repeat(141))).toMatchObject({ length: 282, overLimit: true });
  });

  it('counts graphemes against the limits of the other platforms', () => {
    expect(countText('LINKEDIN', 'a'.repeat(3000))).toMatchObject({
      length: 3000,
      max: 3000,
      overLimit: false,
    });
    expect(countText('LINKEDIN', 'a'.repeat(3001)).overLimit).toBe(true);
    expect(countText('LINKEDIN', FAMILY.repeat(3000))).toMatchObject({ length: 3000, overLimit: false });
    expect(countText('INSTAGRAM', 'a'.repeat(2201))).toMatchObject({ max: 2200, overLimit: true });
    expect(countText('FACEBOOK', 'a'.repeat(63206)).overLimit).toBe(false);
  });

  it('passes the feed folding hint where the platform has one', () => {
    expect(countText('INSTAGRAM', 'a').recommendedLength).toBe(125);
    expect(countText('X', 'a').recommendedLength).toBeUndefined();
  });
});

describe('composePostText', () => {
  it('appends the hashtags after a blank line without repeating those of the body', () => {
    expect(composePostText('Neues Release', ['launch', '#Produkt', 'LAUNCH'])).toBe(
      'Neues Release\n\n#launch #Produkt',
    );
    expect(composePostText('Wir feiern den #Launch', ['launch', 'team'])).toBe(
      'Wir feiern den #Launch\n\n#team',
    );
    expect(composePostText('  Nur Text  ')).toBe('Nur Text');
    expect(composePostText('', ['a'])).toBe('#a');
  });
});

describe('extractHashtags and extractMentions', () => {
  it('finds hashtags with letters, not numbers alone or words with an inner #', () => {
    expect(extractHashtags('#Hallo #2026 #KI_Tipps a#b #München')).toEqual(['Hallo', 'KI_Tipps', 'München']);
  });

  it('finds mentions, not email addresses', () => {
    expect(extractMentions('Danke @anna.k und @team_x! mail@example.com')).toEqual(['anna.k', 'team_x']);
  });
});
