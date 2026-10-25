import { describe, expect, it } from 'vitest';

import { fromLittleText, toLittleText } from './little-text';

// Guide step 4.12: reserved characters of the little text format are escaped, hashtags become
// templates, and the reconcile reads the text back.

describe('toLittleText', () => {
  it('escapes every reserved character', () => {
    expect(toLittleText('a\\b|c{d}e@f[g]h(i)j<k>l*m_n~o')).toBe(
      'a\\\\b\\|c\\{d\\}e\\@f\\[g\\]h\\(i\\)j\\<k\\>l\\*m\\_n\\~o',
    );
  });

  it('turns hashtags into templates and leaves other # escaped', () => {
    expect(toLittleText('#Handwerk und #Kiel_2026, Nummer #1 und C#')).toBe(
      '{hashtag|\\#|Handwerk} und {hashtag|\\#|Kiel\\_2026}, Nummer \\#1 und C\\#',
    );
  });

  it('keeps hashtags with umlauts and at the start of lines', () => {
    expect(toLittleText('Fertig.\n#Wärmepumpe')).toBe('Fertig.\n{hashtag|\\#|Wärmepumpe}');
  });

  it('leaves anchors in links alone as text', () => {
    expect(toLittleText('https://nordlicht.example/#kontakt')).toBe('https://nordlicht.example/\\#kontakt');
  });
});

describe('fromLittleText', () => {
  it('reads back what toLittleText wrote', () => {
    const text = 'Neu (ab Mai): *Wartung* fuer #Waermepumpen_2026 und C# @team';
    expect(fromLittleText(toLittleText(text))).toBe(text);
  });
});
