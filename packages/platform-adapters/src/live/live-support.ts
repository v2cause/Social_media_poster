import { setTimeout as sleep } from 'node:timers/promises';

import { isPlatformError, PlatformError, type AdapterLogger, type Clock, type PublishMedia } from '@smp/core';

import type { PlatformRateLimiter } from '../rate-limit/platform-rate-limiter';

// What the real adapters share (guide steps 4.12 to 4.14): the reading of a rendition from the
// storage, the scopes and expiries of token answers, and the comparison of texts in a reconcile.

/** What every real adapter is built with besides its app credentials. */
export interface LiveAdapterDeps {
  clock: Clock;
  logger?: AdapterLogger;
  limiter?: PlatformRateLimiter;
  /** The fetch of the platform calls and of the rendition downloads; tests pass a fake. */
  fetch?: typeof fetch;
  /** Waits between polls; tests pass one that returns at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The largest rendition a platform takes (LinkedIn and Facebook images stay far below). */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The bytes of a rendition behind its signed URL, for the platforms that take uploads (LinkedIn,
 * Facebook, X). Nothing went out yet when this fails, so a failure can be tried again.
 */
export async function downloadMedia(
  media: PublishMedia,
  options: { signal: AbortSignal; fetch?: typeof fetch },
): Promise<Uint8Array> {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchFn(media.url, {
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      redirect: 'error',
    });
  } catch (error) {
    if (options.signal.aborted) {
      throw error;
    }
    throw new PlatformError('TRANSIENT', 'The rendition could not be read from the storage');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlatformError(
      'TRANSIENT',
      `The rendition could not be read from the storage (HTTP ${String(response.status)})`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new PlatformError('VALIDATION_REJECTED', 'The rendition is larger than any platform takes');
  }
  return bytes;
}

/** A Blob of downloaded bytes, for multipart uploads. */
export const blobOf = (bytes: Uint8Array, mimeType: string): Blob =>
  new Blob([new Uint8Array(bytes)], { type: mimeType });

/**
 * The scopes a token answer names, separated by spaces or commas; the requested ones when the
 * answer names none.
 */
export function scopesOf(
  value: string | readonly string[] | null | undefined,
  requested: readonly string[],
): string[] {
  if (value === null || value === undefined) {
    return [...requested];
  }
  const list = typeof value === 'string' ? value.split(/[\s,]+/) : value;
  const scopes = list.map((scope) => scope.trim()).filter((scope) => scope.length > 0);
  return scopes.length > 0 ? [...new Set(scopes)] : [...requested];
}

/** The end of a token that lives for the given seconds; null when the answer names none. */
export const expiryOf = (clock: Clock, seconds: number | null | undefined): Date | null =>
  seconds === null || seconds === undefined || seconds <= 0
    ? null
    : new Date(clock.now().getTime() + seconds * 1000);

/**
 * The text as platforms keep it: line breaks unified, runs of blanks folded, NFC. Platforms trim
 * and fold whitespace, so a reconcile compares in this form.
 */
export const normalizedText = (text: string): string =>
  text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();

export const sameText = (a: string, b: string): boolean => normalizedText(a) === normalizedText(b);

/** Waits unless the run was stopped meanwhile. */
export const defaultSleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  await sleep(ms, undefined, { signal });
};

/** Whether a text contains a web link, which makes a post on X more expensive. */
export const hasLink = (text: string): boolean => /\bhttps?:\/\/\S/i.test(text);

/**
 * Reads post by post. A rate limit after the first result ends the batch early: the posts without
 * a result are asked for again later (SocialPlatformAdapter.fetchPostMetrics).
 */
export async function collectUntilLimited<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R | undefined>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    try {
      const result = await read(item);
      if (result !== undefined) {
        results.push(result);
      }
    } catch (error) {
      if (results.length > 0 && isPlatformError(error) && error.code === 'RATE_LIMITED') {
        break;
      }
      throw error;
    }
  }
  return results;
}
