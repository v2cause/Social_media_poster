import { setTimeout as sleep } from 'node:timers/promises';

import { PlatformError, type AdapterContext, type PublishMedia } from '@smp/core';

import type { PlatformHttpClient } from '../http/platform-http-client';
import type { ResolvedXConfig } from './x-config';
import { X_COST_OPERATIONS } from './x-costs';
import { mapXApiError } from './x-errors';
import {
  mediaInitializeSchema,
  mediaMetadataSchema,
  mediaStatusSchema,
  type XMediaStatus,
} from './x-schemas';

// The media of a post: the bytes come from the signed URL of the local storage and go to X
// through the chunked upload of API v2, which the docs recommend for all media (guide step 4.14).
// Checked 2026-11-25:
// - https://docs.x.com/x-api/media/introduction: images (tweet_image) up to 5 MB, JPG, PNG, GIF,
//   WEBP; animated GIFs (tweet_gif) up to 15 MB; up to 4 photos or 1 GIF per post; the chunked
//   upload is "recommended", the single POST /2/media/upload "older" and for images only.
// - https://docs.x.com/openapi.json 2.175, operations mediaUploadInitialize (JSON body
//   media_category, media_type, total_bytes), Append (media base64 in JSON with segment_index from
//   0; "a segment can be up to 8 MB; in a JSON body keep it to 4 MB or less"), Finalize (no body;
//   processing_info when X still processes the file) and Get Media Upload Status (GET
//   /2/media/upload?media_id=, wait check_after_secs, until succeeded; failed means unusable).
// - Alt text: POST /2/media/metadata with {id, metadata: {alt_text: {text}}}, text up to 1000
//   characters (same document, operation Create Media Metadata). Billed as Media Metadata,
//   $0.005 per request (https://docs.x.com/x-api/getting-started/pricing).
// - Rate limits per user per 15 minutes: initialize, append and finalize 1,875, status 1,000,
//   metadata 500 (https://docs.x.com/x-api/fundamentals/rate-limits).
// The upload calls are safe to repeat: a lost answer leaves at most an unused upload, no post.
// They skip the own rate limiter: its account bucket would run dry halfway through a post with
// four images, and the limits of X for media are far above what one post needs.

/** Raw bytes per segment; base64 in the JSON body adds a third, which stays under 4 MB. */
const SEGMENT_BYTES = 3 * 1024 * 1024;
const ALT_TEXT_MAX = 1000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const CATEGORIES: Readonly<Record<string, { category: string; maxBytes: number }>> = {
  'image/jpeg': { category: 'tweet_image', maxBytes: 5 * 1024 * 1024 },
  'image/png': { category: 'tweet_image', maxBytes: 5 * 1024 * 1024 },
  'image/webp': { category: 'tweet_image', maxBytes: 5 * 1024 * 1024 },
  'image/gif': { category: 'tweet_gif', maxBytes: 15 * 1024 * 1024 },
};

/** Whether the adapter can upload media of this type. Video is not part of the MVP. */
export const isUploadableMimeType = (mimeType: string): boolean => mimeType in CATEGORIES;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * Cuts the alt text to 1000 characters without splitting one. The docs do not say how X counts
 * the 1000 (maxLength in the OpenAPI document), so the strictest count is used: UTF-16 code
 * units, cut at whole graphemes so emojis and accents stay intact.
 */
export function altTextOf(text: string): string {
  let result = '';
  for (const { segment } of graphemes.segment(text.trim())) {
    if (result.length + segment.length > ALT_TEXT_MAX) {
      break;
    }
    result += segment;
  }
  return result;
}

export class XMediaUploader {
  constructor(
    private readonly config: ResolvedXConfig,
    private readonly http: PlatformHttpClient,
  ) {}

  /** Uploads one item, sets its alt text and returns the media id for POST /2/tweets. */
  async upload(item: PublishMedia, accessToken: string, ctx: AdapterContext): Promise<string> {
    const kind = CATEGORIES[item.mimeType];
    if (!kind) {
      throw new PlatformError('VALIDATION_REJECTED', `X media of type ${item.mimeType} is not supported`);
    }
    const bytes = await this.download(item, kind.maxBytes, ctx.signal);
    await ctx.keepAlive();
    const mediaId = await this.chunked(bytes, item.mimeType, kind.category, accessToken, ctx);
    const altText = item.altText === null ? '' : altTextOf(item.altText);
    if (altText.length > 0) {
      await this.http.request({
        operation: 'x.media.metadata',
        method: 'POST',
        url: `${this.config.apiBaseUrl}/2/media/metadata`,
        headers: this.auth(accessToken),
        body: { json: { id: mediaId, metadata: { alt_text: { text: altText } } } },
        schema: mediaMetadataSchema,
        idempotent: true,
        signal: ctx.signal,
        mapError: mapXApiError('x.media.metadata', this.now),
      });
      await ctx.costs.record({ operation: X_COST_OPERATIONS.mediaMetadata });
    }
    return mediaId;
  }

  /**
   * The rendition from the storage. Nothing went to X yet, so every failure is transient; the
   * signed URL never reaches a message or log.
   */
  private async download(item: PublishMedia, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    if (item.sizeBytes > maxBytes) {
      throw new PlatformError(
        'VALIDATION_REJECTED',
        `The media is larger than X allows (${String(maxBytes)} bytes)`,
      );
    }
    let response: Response;
    try {
      response = await this.config.fetch(item.url, {
        method: 'GET',
        signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
        redirect: 'error',
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown error';
      throw new PlatformError('TRANSIENT', `The media could not be read from the storage (${name})`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformError(
        'TRANSIENT',
        `The storage answered the media download with HTTP ${String(response.status)}`,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new PlatformError(
        'VALIDATION_REJECTED',
        `The media is larger than X allows (${String(maxBytes)} bytes)`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      throw new PlatformError('VALIDATION_REJECTED', 'The media is empty or larger than X allows');
    }
    return bytes;
  }

  private async chunked(
    bytes: Uint8Array,
    mimeType: string,
    category: string,
    accessToken: string,
    ctx: AdapterContext,
  ): Promise<string> {
    const base = `${this.config.apiBaseUrl}/2/media/upload`;
    const common = {
      method: 'POST' as const,
      headers: this.auth(accessToken),
      idempotent: true,
      signal: ctx.signal,
    };
    const init = await this.http.request({
      ...common,
      operation: 'x.media.initialize',
      url: `${base}/initialize`,
      body: { json: { media_category: category, media_type: mimeType, total_bytes: bytes.byteLength } },
      schema: mediaInitializeSchema,
      mapError: mapXApiError('x.media.initialize', this.now),
    });
    const uploadId = init.data.data.id;
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += SEGMENT_BYTES, index += 1) {
      const segment = bytes.subarray(offset, Math.min(offset + SEGMENT_BYTES, bytes.byteLength));
      await this.http.request({
        ...common,
        operation: 'x.media.append',
        url: `${base}/${uploadId}/append`,
        body: { json: { media: Buffer.from(segment).toString('base64'), segment_index: index } },
        mapError: mapXApiError('x.media.append', this.now),
      });
    }
    const finalized = await this.http.request({
      ...common,
      operation: 'x.media.finalize',
      url: `${base}/${uploadId}/finalize`,
      schema: mediaStatusSchema,
      mapError: mapXApiError('x.media.finalize', this.now),
    });
    return this.processed(finalized.data, accessToken, ctx);
  }

  /** Waits while X processes the file (GIFs); a result without processing_info is ready. */
  private async processed(status: XMediaStatus, accessToken: string, ctx: AdapterContext): Promise<string> {
    const deadline = this.now() + this.config.mediaProcessingTimeoutMs;
    let current = status;
    for (;;) {
      const info = current.data.processing_info;
      if (!info || info.state === 'succeeded') {
        return current.data.id;
      }
      if (info.state === 'failed') {
        throw new PlatformError('VALIDATION_REJECTED', 'X could not process the media');
      }
      const waitMs = Math.min((info.check_after_secs ?? 1) * 1000, this.config.maxMediaPollWaitMs);
      if (this.now() + waitMs > deadline) {
        throw new PlatformError('MEDIA_PROCESSING', 'X is still processing the media');
      }
      await sleep(waitMs, undefined, { signal: ctx.signal });
      await ctx.keepAlive();
      const polled = await this.http.request({
        operation: 'x.media.status',
        method: 'GET',
        url: `${this.config.apiBaseUrl}/2/media/upload?media_id=${encodeURIComponent(current.data.id)}&command=STATUS`,
        headers: this.auth(accessToken),
        schema: mediaStatusSchema,
        signal: ctx.signal,
        mapError: mapXApiError('x.media.status', this.now),
      });
      current = polled.data;
    }
  }

  private auth(accessToken: string): Record<string, string> {
    return { authorization: `Bearer ${accessToken}` };
  }

  private readonly now = (): number => this.config.clock.now().getTime();
}
