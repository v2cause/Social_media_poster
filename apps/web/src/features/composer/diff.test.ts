import { describe, expect, it } from 'vitest';

import { diffWords } from './diff';

describe('diffWords', () => {
  it('keeps equal texts as one part', () => {
    expect(diffWords('Ein Satz.', 'Ein Satz.')).toEqual([{ kind: 'same', text: 'Ein Satz.' }]);
  });

  it('marks replaced and added words and keeps line breaks', () => {
    expect(diffWords('Hallo Welt.\n\nBis bald.', 'Hallo Köln.\n\nBis bald!')).toEqual([
      { kind: 'same', text: 'Hallo ' },
      { kind: 'removed', text: 'Welt.' },
      { kind: 'added', text: 'Köln.' },
      { kind: 'same', text: '\n\nBis ' },
      { kind: 'removed', text: 'bald.' },
      { kind: 'added', text: 'bald!' },
    ]);
  });

  it('shows a removed tail and an added opening', () => {
    expect(diffWords('Kurz eingeordnet: Text', 'Text')).toEqual([
      { kind: 'removed', text: 'Kurz eingeordnet: ' },
      { kind: 'same', text: 'Text' },
    ]);
  });

  it('shows very long texts as replaced', () => {
    const long = 'Wort '.repeat(3000);
    expect(diffWords(long, `${long}mehr`)).toEqual([
      { kind: 'removed', text: long },
      { kind: 'added', text: `${long}mehr` },
    ]);
  });
});
