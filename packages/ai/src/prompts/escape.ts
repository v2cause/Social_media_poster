/**
 * Escapes user-provided text that goes inside prompt tags, so it cannot close a tag or open a
 * new one. The model reads the entities as the characters they stand for.
 */
export const escapeData = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Normalizes line endings and trims, so the same input always renders the same bytes. */
export const normalizeText = (value: string): string => value.replace(/\r\n?/g, '\n').trim();

export const dataText = (value: string): string => escapeData(normalizeText(value));
