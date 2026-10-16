import { describe, expect, it } from 'vitest';

import { detectLanguage } from './language';

describe('detectLanguage', () => {
  it('recognizes German and English posts', () => {
    expect(
      detectLanguage('Wir haben die Bearbeitungszeit halbiert, und das merken unsere Kunden jeden Tag.'),
    ).toBe('de');
    expect(detectLanguage('We cut the response time in half, and our customers notice it every day.')).toBe(
      'en',
    );
  });

  it('stays undecided for short or mixed texts', () => {
    expect(detectLanguage('Heizung check!')).toBe('unknown');
    expect(detectLanguage('Das ist the best, und we love it, oder?')).toBe('unknown');
  });
});
