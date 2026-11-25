import { PlatformError, type PublishMedia } from '@smp/core';

import type { HttpBody } from '../http/platform-http-client';

// Media for Facebook come from the local storage as signed URLs (http://localhost:8333/...), which
// Meta cannot reach. Facebook takes the bytes instead: "Attach the photo as multipart/form-data.
// The name of the object doesn't matter, but historically people have used source as the parameter
// name for the photo." Photos may be .jpeg, .bmp, .png, .gif, .tiff and "can not exceed 10MB".
// Checked 2026-11-25: https://developers.facebook.com/docs/graph-api/reference/page/photos/
// Neither the signed URL nor the bytes reach a log or an error message.

/** The photo limit of Facebook. */
export const FACEBOOK_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface DownloadOptions {
  maxBytes: number;
  signal: AbortSignal;
  timeoutMs?: number;
}

/** Downloads a rendition from the storage; failures of the storage are TRANSIENT. */
export async function downloadMedia(
  fetchFn: typeof fetch,
  media: PublishMedia,
  options: DownloadOptions,
): Promise<Uint8Array> {
  if (media.sizeBytes > options.maxBytes) {
    throw tooLarge(options.maxBytes);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(media.url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([options.signal, timeout]),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown error';
    throw new PlatformError('TRANSIENT', `The media could not be loaded from the storage (${name})`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlatformError(
      'TRANSIENT',
      `The media could not be loaded from the storage (HTTP ${String(response.status)})`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > options.maxBytes) {
    await response.body?.cancel();
    throw tooLarge(options.maxBytes);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > options.maxBytes) {
    throw tooLarge(options.maxBytes);
  }
  if (bytes.byteLength === 0) {
    throw new PlatformError('TRANSIENT', 'The storage returned an empty media file');
  }
  return bytes;
}

function tooLarge(maxBytes: number): PlatformError {
  return new PlatformError(
    'VALIDATION_REJECTED',
    `The media is larger than the platform accepts (${String(Math.round(maxBytes / 1024 / 1024))} MB)`,
  );
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
};

/** A multipart/form-data body with the fields and the file as "source". */
export async function multipartBody(
  fields: Readonly<Record<string, string>>,
  file: { bytes: Uint8Array; mimeType: string },
): Promise<HttpBody> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  const extension = EXTENSIONS[file.mimeType.toLowerCase()] ?? 'bin';
  form.append(
    'source',
    new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
    `photo.${extension}`,
  );
  // The fetch of Node encodes the form and picks the boundary; nothing is sent here.
  const encoded = new Request('http://multipart.invalid/', { method: 'POST', body: form });
  const contentType = encoded.headers.get('content-type');
  if (contentType === null) {
    throw new Error('The multipart body has no content type.');
  }
  return { bytes: new Uint8Array(await encoded.arrayBuffer()), contentType };
}
