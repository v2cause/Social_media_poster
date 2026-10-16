// The forbidden words of a brand voice in a post (architecture 5.3, Leitplanken). The server
// checks every generated variant, and the composer shows the same result while the user types.

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words and phrases that appear in the texts: whole words, case-insensitive, any script. */
export function findForbiddenWords(texts: readonly string[], forbidden: readonly string[]): string[] {
  const haystack = texts.join('\n');
  return forbidden.filter((word) => {
    const trimmed = word.trim();
    return (
      trimmed.length > 0 &&
      new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, 'iu').test(haystack)
    );
  });
}
