import type { NotificationChannels, NotificationType } from './types';

// Rules of the notifications (guide step 4.9, ADR 0025).

/**
 * Who acts on a notification: the owners and admins manage the connections, the author of a
 * post decides about it (and when the author is gone, the owners and admins).
 */
export const audienceOf = (type: NotificationType): 'channel_managers' | 'post_author' =>
  type === 'token-expiring' || type === 'reauth-required' ? 'channel_managers' : 'post_author';

/** Without a setting of the user, a notification goes out in the app and by email. */
export const DEFAULT_CHANNELS: NotificationChannels = { inApp: true, email: true };

/** A post appears in a notification with the first 80 characters of its text. */
export const PREVIEW_LENGTH = 80;
/** And with 320 UTF-16 code units at most, so a text full of emoji stays short as well. */
export const PREVIEW_MAX_UNITS = 320;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The text on one line, cut after whole graphemes, so no character is split. */
export function previewOf(text: string): string {
  const parts = Array.from(graphemes.segment(text.replace(/\s+/g, ' ').trim()), (part) => part.segment);
  const whole = parts.join('');
  if (parts.length <= PREVIEW_LENGTH && whole.length <= PREVIEW_MAX_UNITS) {
    return whole;
  }
  let preview = '';
  // One place is left for the ellipsis.
  for (const part of parts.slice(0, PREVIEW_LENGTH - 1)) {
    if (preview.length + part.length >= PREVIEW_MAX_UNITS) {
      break;
    }
    preview += part;
  }
  return `${preview.trimEnd()}…`;
}
