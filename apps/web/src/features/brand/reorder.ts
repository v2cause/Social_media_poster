// Sorting of the custom styles (guide step 2.9), by drag and drop or with the arrow buttons.

/** The list with the item at `from` moved to position `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return next;
  }
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) {
    next.splice(to, 0, moved);
  }
  return next;
}

/** The items whose stored order differs from their new position, with that position. */
export function sortOrderChanges<T extends { sortOrder: number }>(
  ordered: readonly T[],
): { item: T; sortOrder: number }[] {
  return ordered.flatMap((item, index) => (item.sortOrder === index ? [] : [{ item, sortOrder: index }]));
}
