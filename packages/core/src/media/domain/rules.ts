import type { MemberRole } from '../../tenancy/domain/types';
import type { Crop } from './types';

// Rules of the media pipeline (architecture 9, ADR 0008).

/** JPEG, PNG, WebP and static GIF. No SVG: it can carry scripts. */
export const UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type UploadMimeType = (typeof UPLOAD_MIME_TYPES)[number];

export const isUploadMimeType = (value: string): value is UploadMimeType =>
  (UPLOAD_MIME_TYPES as readonly string[]).includes(value);

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Images with more pixels are refused before they are decoded in full. */
export const MAX_INPUT_PIXELS = 50_000_000;

/** A presigned upload works for five minutes. */
export const UPLOAD_URL_SECONDS = 5 * 60;
/** Previews in the browser and images for platforms are readable for one hour. */
export const READ_URL_SECONDS = 60 * 60;

/** The WebP thumbnails of every accepted image, profiles of @smp/platform-rules. */
export const THUMBNAIL_PROFILES = ['thumb_320', 'thumb_640'] as const;
/** The crop hash of a rendition of the whole image. */
export const FULL_IMAGE = 'full';

/** The most media one variant holds; LinkedIn takes the most with 20 images. */
export const MAX_VARIANT_MEDIA = 20;

/**
 * Identifies crop and letterbox in the key of a rendition, for example "x0y120w1080h1350" or
 * "full-lb". Readable, and only letters, digits and "-", as object keys need.
 */
export function cropHashOf(crop: Crop | null, letterbox: boolean): string {
  const region = crop
    ? `x${String(crop.x)}y${String(crop.y)}w${String(crop.width)}h${String(crop.height)}`
    : FULL_IMAGE;
  return letterbox ? `${region}-lb` : region;
}

/** Editors and above upload and change media; viewers only see the library. */
export const canWriteMedia = (role: MemberRole): boolean => role !== 'VIEWER';

const FILE_NAME_MAX = 255;

/** The file name as the library shows it: one line, no control characters, at most 255 characters. */
export function displayFileName(name: string): string {
  let line = '';
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    line += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  const cleaned = line.replace(/[\\/]/g, '_').trim().slice(0, FILE_NAME_MAX);
  return cleaned.length > 0 ? cleaned : 'image';
}
