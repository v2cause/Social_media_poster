import type { GeneratedVariant } from '@smp/core';
import { describe, expect, it } from 'vitest';

import { checkVariant } from './checks';

const variant = (fields: Partial<GeneratedVariant>): GeneratedVariant => ({
  targetKey: 't1',
  platform: 'X',
  hook: 'Wir haben die Bearbeitungszeit halbiert.',
  text: 'Wir haben die Bearbeitungszeit halbiert. Das merken unsere Kunden jeden Tag, und wir sind stolz auf das Team.',
  hashtags: ['Service'],
  firstComment: null,
  callToAction: null,
  altTexts: [],
  warnings: [],
  ...fields,
});

const expected = { language: 'de' as const, forbiddenWords: ['billig'] };

describe('checkVariant', () => {
  it('passes a valid variant for its target', () => {
    const check = checkVariant(variant({}), { key: 't1', platform: 'X' }, expected);

    expect(check).toMatchObject({
      schemaValid: true,
      matchesTarget: true,
      withinLimit: true,
      issues: [],
      forbiddenWords: [],
      language: 'de',
      languageCorrect: true,
    });
    expect(check.maxLength).toBe(280);
  });

  it('flags length, forbidden words, platform issues, the wrong target and the wrong language', () => {
    const check = checkVariant(
      variant({
        targetKey: 't2',
        text: 'We are the best and it is cheap, billig even. '.repeat(10),
        hashtags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'],
        firstComment: 'Link',
      }),
      { key: 't1', platform: 'X' },
      expected,
    );

    expect(check.matchesTarget).toBe(false);
    expect(check.withinLimit).toBe(false);
    expect(check.forbiddenWords).toEqual(['billig']);
    expect(check.issues).toContain('FIRST_COMMENT_NOT_SUPPORTED');
    expect(check.language).toBe('en');
    expect(check.languageCorrect).toBe(false);
  });
});
