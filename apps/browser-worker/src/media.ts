import type { EgressPolicy } from '@smp/x-browser';

// The media of a post, loaded from their signed URLs before the browser starts (guide step 6.2):
// only from hosts of the egress policy, without redirects, within 30 seconds and up to 16 MB,
// which is more than X takes for an image or a GIF. The bytes go to the composer as files.

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 30_000;

export interface MediaFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
  altText: string | null;
}

export class MediaUnavailableError extends Error {
  constructor(readonly reason: 'refused_host' | 'status' | 'too_large' | 'network') {
    super(`The media could not be loaded: ${reason}.`);
    this.name = 'MediaUnavailableError';
  }
}

export type MediaFetcher = (url: string) => Promise<Buffer>;

export function mediaFetcher(policy: EgressPolicy, fetchImpl: typeof fetch = fetch): MediaFetcher {
  return async (url) => {
    if (!/^https?:\/\//i.test(url) || !policy.allowsUrl(url)) {
      throw new MediaUnavailableError('refused_host');
    }
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    } catch {
      throw new MediaUnavailableError('network');
    }
    if (!response.ok || !response.body) {
      throw new MediaUnavailableError('status');
    }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_MEDIA_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new MediaUnavailableError('too_large');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > MAX_MEDIA_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new MediaUnavailableError('too_large');
        }
        chunks.push(value);
      }
    } catch (error) {
      throw error instanceof MediaUnavailableError ? error : new MediaUnavailableError('network');
    }
    return Buffer.concat(chunks);
  };
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** The file name the composer gets, for example image-1.jpg. */
export const mediaFileName = (index: number, mimeType: string): string =>
  `image-${String(index + 1)}.${EXTENSIONS[mimeType] ?? 'bin'}`;
