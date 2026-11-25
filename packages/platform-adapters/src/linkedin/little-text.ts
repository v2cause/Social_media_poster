// The "little Text Format" of the Posts API commentary (guide step 4.12). Every reserved character
// is escaped with a backslash, even outside of an element; an unescaped one starts an element, and
// LinkedIn cuts or misreads the text. Hashtags go out as HashtagTemplate {hashtag|\#|tag}. Mentions
// would need the URN of the member or page, which the posts do not carry, so an @ stays text.
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
// (checked 2026-11-25): reserved are | { } @ [ ] ( ) < > # \ * _ ~
// Not settled by the docs: whether the escapes count towards the length limit of the commentary.

const RESERVED = /[|{}@[\]()<>#\\*_~]/g;

/**
 * A hashtag as @smp/platform-rules counts it (extractHashtags): # after a non-word character, then
 * letters, digits and underscores with at least one letter, so #2026 stays text.
 */
const HASHTAG = /(?<![\p{L}\p{N}\p{M}_&])#([\p{L}\p{N}\p{M}_]*[\p{L}\p{M}_][\p{L}\p{N}\p{M}_]*)/gu;

/** The HashtagTemplate as LinkedIn returns it in a read post: {hashtag|\#|tag} or the fullwidth sign. */
const TEMPLATE = /\{hashtag\|\\?[#＃]\|((?:\\.|[^\\}])*)\}/g;

/** Escapes every reserved character, so the text is shown as written. */
export const escapeLittleText = (text: string): string => text.replace(RESERVED, (char) => `\\${char}`);

/** The commentary of a post: escaped text with its hashtags as templates. */
export function toLittleText(text: string): string {
  const source = text.normalize('NFC');
  let result = '';
  let last = 0;
  for (const match of source.matchAll(HASHTAG)) {
    const tag = match[1] ?? '';
    result += `${escapeLittleText(source.slice(last, match.index))}{hashtag|\\#|${escapeLittleText(tag)}}`;
    last = match.index + 1 + tag.length;
  }
  return result + escapeLittleText(source.slice(last));
}

/** The plain text of a commentary, to compare a read post with the text that was sent. */
export function fromLittleText(commentary: string): string {
  return commentary
    .replace(TEMPLATE, (_match, tag: string) => `#${tag}`)
    .replace(/\\(.)/gu, '$1')
    .normalize('NFC');
}
