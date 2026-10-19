// Arrow keys within a group of controls with one stop in the tab order, as in the tabs pattern of
// the WAI-ARIA Authoring Practices (guide step 8.8): left and right move and wrap around, Home and
// End go to the first and the last control.

/** The index the key moves to among count controls, or null for a key the group leaves alone. */
export function rovingTarget(key: string, index: number, count: number): number | null {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
