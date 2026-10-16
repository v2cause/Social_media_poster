import { describe, expect, it } from 'vitest';

import { moveItem, sortOrderChanges } from './reorder';

describe('moveItem', () => {
  it('moves an item down and up', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('keeps the list for moves outside of it', () => {
    expect(moveItem(['a', 'b'], 0, 2)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });
});

describe('sortOrderChanges', () => {
  it('stores the new position of every item that moved, and only those', () => {
    const styles = [
      { id: 'c', sortOrder: 2 },
      { id: 'b', sortOrder: 1 },
      { id: 'a', sortOrder: 0 },
    ];

    expect(sortOrderChanges(styles)).toEqual([
      { item: styles[0], sortOrder: 0 },
      { item: styles[2], sortOrder: 2 },
    ]);
  });

  it('closes gaps left by deleted or older orders', () => {
    expect(sortOrderChanges([{ sortOrder: 0 }, { sortOrder: 5 }]).map((change) => change.sortOrder)).toEqual([
      1,
    ]);
  });
});
