import { describe, expect, it } from 'vitest';

import { escapeLittleText, fromLittleText, toLittleText } from './little-text';

// Guide step 4.12: reserved characters of the little Text Format are escaped, hashtags go out as
// HashtagTemplate (little-text-format, checked 2026-11-25).

describe('little Text Format', () => {
  it('escapes every reserved character with a backslash', () => {
    expect(escapeLittleText('| { } @ [ ] ( ) < > # \\ * _ ~')).toBe(
      '\\| \\{ \\} \\@ \\[ \\] \\( \\) \\< \\> \\# \\\\ \\* \\_ \\~',
    );
    expect(escapeLittleText('Plain text, 100% fine! "quoted" & more.')).toBe(
      'Plain text, 100% fine! "quoted" & more.',
    );
  });

  it('matches the bullet sample of the documentation', () => {
    expect(toLittleText('Hello, these are some bullet points:\n\n* Point 1\n* Point 2\n* Point 3')).toBe(
      'Hello, these are some bullet points:\n\n\\* Point 1\n\\* Point 2\n\\* Point 3',
    );
  });

  it('turns hashtags into templates and leaves other # as escaped text', () => {
    expect(toLittleText('Follow best practices #coding')).toBe('Follow best practices {hashtag|\\#|coding}');
    expect(toLittleText('#Handwerk in Kiel (seit 1998) #KI_Tipps #München')).toBe(
      '{hashtag|\\#|Handwerk} in Kiel \\(seit 1998\\) {hashtag|\\#|KI\\_Tipps} {hashtag|\\#|München}',
    );
    expect(toLittleText('Ticket #2026 and a#b, mail@example.com')).toBe(
      'Ticket \\#2026 and a\\#b, mail\\@example.com',
    );
  });

  it('reads a commentary back to the text that was sent', () => {
    const texts = [
      'Unsere neue Werkstatt in Kiel ist fertig. #Handwerk',
      'Brackets [x] (y) {z} <a> ~b~ *c* _d_ \\e | @f #g_h',
      'Follow best practices {hashtag|\\#|coding} as text',
    ];
    for (const text of texts) {
      expect(fromLittleText(toLittleText(text))).toBe(text);
    }
    // LinkedIn returns a plain hashtag of the request as a template.
    expect(fromLittleText('Follow best practices {hashtag|\\#|coding}')).toBe(
      'Follow best practices #coding',
    );
  });
});
