import { createHash } from 'node:crypto';

import {
  ImageRejectedError,
  MAX_INPUT_PIXELS,
  type EncodedImage,
  type EncodeOptions,
  type ImageInfo,
  type ImageProcessor,
} from '@smp/core';
import sharp from 'sharp';

// The ImageProcessor of the media pipeline on sharp (guide step 3.3, architecture 9). Every
// output is a new encoding: rotated by the EXIF orientation, in sRGB and without metadata, so
// EXIF and GPS data never leave the original. The original itself is never served.
//
// failOn 'error' aborts on corrupt and truncated pixel data but keeps photos whose decoder only
// warns, as many cameras produce them (sharp's default 'warning' would refuse those).

export interface SharpImageProcessorOptions {
  /** libvips threads per image; the worker also limits how many jobs run at once. */
  threads?: number;
}

const INPUT_OPTIONS = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' } as const;

const MIME_TYPES = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' } as const;

/** Errors of sharp for an input it refuses, as a reason the user sees. */
function rejection(error: unknown): ImageRejectedError {
  const message = error instanceof Error ? error.message : '';
  return new ImageRejectedError(/pixel limit/i.test(message) ? 'DIMENSIONS_TOO_LARGE' : 'CORRUPT_IMAGE');
}

export class SharpImageProcessor implements ImageProcessor {
  constructor(options: SharpImageProcessorOptions = {}) {
    // Settings of the process, not of the instance. Without the cache, memory goes back right
    // after each image.
    sharp.cache(false);
    sharp.concurrency(options.threads ?? 1);
  }

  async inspect(bytes: Uint8Array): Promise<ImageInfo> {
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(bytes, INPUT_OPTIONS).metadata();
    } catch (error) {
      throw rejection(error);
    }
    // The header alone decides; the pixels are decoded only within the limit.
    if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
      throw new ImageRejectedError('DIMENSIONS_TOO_LARGE');
    }
    return {
      format: metadata.format,
      width: metadata.autoOrient.width,
      height: metadata.autoOrient.height,
      frames: metadata.pages ?? 1,
    };
  }

  async encode(bytes: Uint8Array, options: EncodeOptions): Promise<EncodedImage> {
    let pipeline = sharp(bytes, INPUT_OPTIONS)
      .rotate()
      .resize({
        width: options.maxWidth,
        height: options.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb');
    if (options.format === 'jpeg') {
      // JPEG has no transparency: transparent areas turn white instead of black.
      pipeline = pipeline
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: options.quality, mozjpeg: true });
    } else if (options.format === 'webp') {
      pipeline = pipeline.webp({ quality: options.quality });
    } else {
      pipeline = pipeline.png();
    }
    try {
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      return {
        bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        mimeType: MIME_TYPES[options.format],
        width: info.width,
        height: info.height,
      };
    } catch (error) {
      throw rejection(error);
    }
  }

  sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
