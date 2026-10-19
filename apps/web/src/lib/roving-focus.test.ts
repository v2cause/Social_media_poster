import { describe, expect, it } from 'vitest';

import { rovingTarget } from './roving-focus';

describe('rovingTarget', () => {
  it('moves with the arrow keys and wraps around at both ends', () => {
    expect(rovingTarget('ArrowRight', 0, 3)).toBe(1);
    expect(rovingTarget('ArrowRight', 2, 3)).toBe(0);
    expect(rovingTarget('ArrowLeft', 1, 3)).toBe(0);
    expect(rovingTarget('ArrowLeft', 0, 3)).toBe(2);
  });

  it('goes to the first and the last control with Home and End', () => {
    expect(rovingTarget('Home', 2, 4)).toBe(0);
    expect(rovingTarget('End', 0, 4)).toBe(3);
  });

  it('leaves other keys and an empty group alone', () => {
    expect(rovingTarget('Enter', 1, 3)).toBeNull();
    expect(rovingTarget('ArrowDown', 1, 3)).toBeNull();
    expect(rovingTarget('ArrowRight', 0, 0)).toBeNull();
  });
});
