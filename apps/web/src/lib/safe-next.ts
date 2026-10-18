// The URL parser drops tabs and line breaks and reads a backslash like a slash, so "/\t/evil" and
// "/\evil" would lead to another site. Such values are refused before the path is resolved
// against a placeholder origin; only a path that stays on that origin is kept. Dot segments can
// leave a path with two leading slashes ("/..//evil" becomes "//evil"), which a browser reads as
// another host, so the resolved path is checked once more.
const BASE = 'https://app.invalid';

/** Control characters (U+0000 to U+001F, U+007F) and backslashes. */
const hasUnsafeCharacter = (value: string): boolean =>
  Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || char === '\\';
  });

/** Accepts only paths on this site as redirect target after sign-in; anything else goes home. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || hasUnsafeCharacter(next)) {
    return '/';
  }
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return '/';
  }
  if (url.origin !== BASE || url.pathname.startsWith('//')) {
    return '/';
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
