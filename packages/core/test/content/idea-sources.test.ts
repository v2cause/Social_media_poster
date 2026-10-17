import { describe, expect, it } from 'vitest';

import { postSourceOf, resolveIdeaSources, topPostRefOf, variantIdOfSource } from '../../src';

// Guide step 5.6: an idea points at the published posts it builds on.

const VARIANT = '0190a6a2-6c5e-7d3f-8a1b-2c3d4e5f6a7b';

describe('idea sources', () => {
  it('stores a post as its variant and reads it back', () => {
    expect(postSourceOf(VARIANT)).toBe(`variant:${VARIANT}`);
    expect(variantIdOfSource(`variant:${VARIANT}`)).toBe(VARIANT);
    expect(variantIdOfSource('Content-Säule')).toBeNull();
    expect(variantIdOfSource('variant:nope')).toBeNull();
  });

  it('reads the ref of a top post the way the model may write it', () => {
    expect(['top-1', ' Top-1 ', 'top 1', 'TOP_1'].map(topPostRefOf)).toEqual([
      'top-1',
      'top-1',
      'top-1',
      'top-1',
    ]);
  });

  it('resolves refs, drops refs without a post and keeps the rest once', () => {
    const posts = new Map([['top-1', VARIANT]]);
    expect(
      resolveIdeaSources(['top-1', 'top 1', 'top-3', ' Firmenprofil ', '', 'Firmenprofil'], posts),
    ).toEqual([`variant:${VARIANT}`, 'Firmenprofil']);
  });
});
