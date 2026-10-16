import { describe, expect, it } from 'vitest';

import { SLUG_PATTERN, slugify, withSuffix } from './slug';

describe('slugify', () => {
  it.each([
    ['Marketing & Sales', 'marketing-sales'],
    ['Müller Bäckerei GmbH', 'muller-backerei-gmbh'],
    ['Straße 42', 'strasse-42'],
    ['  --Acme--  ', 'acme'],
    ['!', 'workspace'],
    ['a'.repeat(60), 'a'.repeat(40)],
  ])('turns %j into %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
    expect(slug).toMatch(SLUG_PATTERN);
  });

  it('keeps the length limit with a suffix', () => {
    expect(withSuffix('a'.repeat(40), 'k3x9')).toBe(`${'a'.repeat(35)}-k3x9`);
  });
});
