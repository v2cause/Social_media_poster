// Decoding and encoding of images (guide step 3.3). Implemented with sharp in @smp/media.
// Implementations throw ImageRejectedError for images they refuse.

export interface ImageInfo {
  /** As the decoder reads it, for example "jpeg". */
  format: string;
  /** The size after applying the EXIF orientation. */
  width: number;
  height: number;
  /** More than one for animations. */
  frames: number;
}

export interface EncodeOptions {
  format: 'jpeg' | 'webp' | 'png';
  /** 1 to 100. */
  quality: number;
  /** The result fits into this box without being enlarged. */
  maxWidth: number;
  maxHeight: number;
}

/** The steps of a platform rendition, as planRendition() of @smp/platform-rules plans them. */
export interface RenderOptions {
  /** The region to cut out, in pixels of the image after its EXIF orientation; null for all. */
  extract: { x: number; y: number; width: number; height: number } | null;
  /** The size of the content after scaling. */
  resize: { width: number; height: number };
  /** White bars around the content, in pixels of the result; null for none. */
  extend: { top: number; right: number; bottom: number; left: number } | null;
  format: 'jpeg' | 'webp';
  /** 1 to 100. */
  quality: number;
}

export interface EncodedImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

export interface ImageProcessor {
  inspect(bytes: Uint8Array): Promise<ImageInfo>;
  /** A new image: rotated by its EXIF orientation, in sRGB and without metadata (EXIF, GPS). */
  encode(bytes: Uint8Array, options: EncodeOptions): Promise<EncodedImage>;
  /** A rendition with crop and bars, likewise oriented, in sRGB and without metadata. */
  render(bytes: Uint8Array, options: RenderOptions): Promise<EncodedImage>;
  /** The SHA-256 of the bytes as hex. */
  sha256(bytes: Uint8Array): string;
}
