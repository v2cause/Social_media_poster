import { PlatformError, type PublishMedia } from '@smp/core';

// LinkedIn does not fetch images from a URL: the adapter reads the rendition from the signed URL of
// the storage (a local S3 in single-user mode) and uploads the bytes. The signed URL carries its
// signature in the query, so it is never logged or put into a message.

export interface MediaDownloadOptions {
  fetch: typeof fetch;
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}

/** The bytes of a rendition; TRANSIENT when the storage does not answer, so the job tries again. */
export async function downloadMedia(media: PublishMedia, options: MediaDownloadOptions): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(media.url);
  } catch {
    throw new PlatformError('VALIDATION_REJECTED', 'The image URL of the rendition is not valid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PlatformError('VALIDATION_REJECTED', 'The image URL of the rendition is not http(s)');
  }
  if (media.sizeBytes > options.maxBytes) {
    throw new PlatformError('VALIDATION_REJECTED', 'The image is larger than the upload limit');
  }
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown error';
    throw new PlatformError('TRANSIENT', `The image could not be read from the storage (${name})`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    // An expired signed URL (403) is fixed by the next attempt, which signs a new one.
    throw new PlatformError(
      'TRANSIENT',
      `The image could not be read from the storage (HTTP ${String(response.status)})`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > options.maxBytes) {
    await response.body?.cancel();
    throw new PlatformError('VALIDATION_REJECTED', 'The image is larger than the upload limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > options.maxBytes) {
    throw new PlatformError('VALIDATION_REJECTED', 'The image from the storage is empty or too large');
  }
  return bytes;
}
