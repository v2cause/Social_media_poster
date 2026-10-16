import { describe, expect, it } from 'vitest';

import { findForbiddenWords } from './forbidden-words';

describe('findForbiddenWords', () => {
  it('finds whole words and phrases regardless of case', () => {
    expect(
      findForbiddenWords(
        ['Echte Synergien statt Synergie-Gerede.', 'Game Changer!'],
        ['synergie', 'game changer', 'Gerede', 'neu'],
      ),
    ).toEqual(['synergie', 'game changer', 'Gerede']);
  });

  it('does not match inside other words, also with umlauts', () => {
    expect(findForbiddenWords(['Überragend und grün.'], ['ragend', 'grün', 'Über'])).toEqual(['grün']);
  });

  it('treats regular expression characters as text', () => {
    expect(findForbiddenWords(['Kosten (netto) sinken.'], ['(netto)', 'n.tto'])).toEqual(['(netto)']);
  });
});
