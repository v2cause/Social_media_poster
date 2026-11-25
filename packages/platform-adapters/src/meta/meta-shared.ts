import { PlatformError, type PublishRequest } from '@smp/core';
import type { MediaItem } from '@smp/platform-rules';

// Small helpers of both Meta adapters.

/** Graph times look like 2019-01-02T18:31:28+0000; Date.parse wants the offset with a colon. */
export function parseGraphTime(value: string): Date | null {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const time = Date.parse(normalized);
  return Number.isNaN(time) ? null : new Date(time);
}

/** Unix seconds, as Graph takes them in since and until. */
export const unixSeconds = (date: Date): string => String(Math.floor(date.getTime() / 1000));

/** Texts compare without line ending and outer whitespace differences. */
export const sameText = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

/** The media of a request as the platform rules check them. */
export function mediaItemsOf(request: PublishRequest): MediaItem[] {
  return request.media.map((item) => ({
    kind: item.mimeType.toLowerCase().startsWith('video/') ? 'video' : 'image',
    mimeType: item.mimeType,
    width: item.width,
    height: item.height,
  }));
}

/** A path segment of a Graph id; ids are digits and underscores (post ids are page_post). */
export function graphId(id: string): string {
  if (!/^[0-9_]{1,64}$/.test(id)) {
    throw new PlatformError('VALIDATION_REJECTED', 'The id is not a Graph object id', { retryable: false });
  }
  return id;
}
