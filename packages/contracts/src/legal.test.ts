/// <reference types="node" />
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { riskTextOf, X_BROWSER_RISK } from './legal';
import { LOCALES } from './locale';

describe('X_BROWSER_RISK', () => {
  it('names the hash of each text, so a changed text needs a new version', () => {
    for (const locale of LOCALES) {
      const hash = createHash('sha256').update(X_BROWSER_RISK.texts[locale], 'utf8').digest('hex');
      expect(hash, locale).toBe(X_BROWSER_RISK.hashes[locale]);
    }
  });

  it('has a dated version and the same points in every language', () => {
    expect(X_BROWSER_RISK.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const points = (text: string): number => text.split('\n').filter((line) => line.startsWith('- ')).length;
    expect(points(X_BROWSER_RISK.texts.de)).toBe(7);
    expect(points(X_BROWSER_RISK.texts.en)).toBe(points(X_BROWSER_RISK.texts.de));
  });

  it('gives the use cases the version and the hash of a language, none for another language', () => {
    const text = riskTextOf(X_BROWSER_RISK);
    expect(text.version).toBe(X_BROWSER_RISK.version);
    expect(text.hashOf('de')).toBe(X_BROWSER_RISK.hashes.de);
    expect(text.hashOf('fr')).toBeNull();
  });
});
