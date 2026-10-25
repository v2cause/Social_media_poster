// The commentary of a LinkedIn post is "little text" (guide step 4.12): its reserved characters
// start elements such as mentions and hashtags, and an unescaped one cuts the post short. Every
// reserved character outside an element gets a backslash; a hashtag becomes the hashtag template
// {hashtag|\#|Tag}, so it stays a link. Reserved set and template after the Little Text Format
// page (learn.microsoft.com, read through its search excerpt on 2026-10-25; the page itself is not
// reachable from the development environment, ADR 0046).

const RESERVED = /[\\|{}@[\]()<>#*_~]/g;

const escapeReserved = (text: string): string => text.replace(RESERVED, (character) => `\\${character}`);

/**
 * A hashtag: # after the start, a blank or punctuation that is not part of a word, followed by
 * letters, digits or underscores with at least one letter.
 */
const HASHTAG = /(^|[^\p{L}\p{N}_&/])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu;

/** The commentary in little text: hashtags as templates, every other reserved character escaped. */
export function toLittleText(text: string): string {
  let result = '';
  let last = 0;
  for (const match of text.matchAll(HASHTAG)) {
    const prefix = match[1] ?? '';
    const tag = match[2] ?? '';
    const start = match.index + prefix.length;
    result += escapeReserved(text.slice(last, start));
    result += `{hashtag|\\#|${escapeReserved(tag)}}`;
    last = start + 1 + tag.length;
  }
  return result + escapeReserved(text.slice(last));
}

/**
 * The plain text of a commentary as LinkedIn returns it, for the reconcile: hashtag templates
 * back to #Tag, escapes removed.
 */
export function fromLittleText(commentary: string): string {
  return commentary
    .replace(/\{hashtag\|\\?#\|((?:\\.|[^}\\])*)\}/g, (_all, tag: string) => `#${tag}`)
    .replace(/\\(.)/g, '$1');
}
