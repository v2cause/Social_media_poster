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
  /** The SHA-256 of the bytes as hex. */
  sha256(bytes: Uint8Array): string;
}
