import { createHash } from 'node:crypto';

import {
  ImageRejectedError,
  MAX_INPUT_PIXELS,
  type EncodedImage,
  type EncodeOptions,
  type ImageInfo,
  type ImageProcessor,
  type RenderOptions,
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

const WHITE = '#ffffff';

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

  encode(bytes: Uint8Array, options: EncodeOptions): Promise<EncodedImage> {
    const pipeline = sharp(bytes, INPUT_OPTIONS)
      .rotate()
      .resize({
        width: options.maxWidth,
        height: options.maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toColourspace('srgb');
    return this.output(pipeline, options);
  }

  render(bytes: Uint8Array, options: RenderOptions): Promise<EncodedImage> {
    // With autoOrient the crop lies in the image as it is shown, as the user cropped it.
    let pipeline = sharp(bytes, { ...INPUT_OPTIONS, autoOrient: true });
    if (options.extract) {
      const { x, y, width, height } = options.extract;
      pipeline = pipeline.extract({ left: x, top: y, width, height });
    }
    pipeline = pipeline.resize(options.resize.width, options.resize.height, { fit: 'fill' });
    if (options.extend) {
      // sharp adds the bars after scaling, in pixels of the result.
      pipeline = pipeline.extend({ ...options.extend, background: WHITE });
    }
    return this.output(pipeline.toColourspace('srgb'), options);
  }

  sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  private async output(
    pipeline: sharp.Sharp,
    options: { format: 'jpeg' | 'webp' | 'png'; quality: number },
  ): Promise<EncodedImage> {
    let encoder = pipeline;
    if (options.format === 'jpeg') {
      // JPEG has no transparency: transparent areas turn white instead of black.
      encoder = encoder.flatten({ background: WHITE }).jpeg({ quality: options.quality, mozjpeg: true });
    } else if (options.format === 'webp') {
      encoder = encoder.webp({ quality: options.quality });
    } else {
      encoder = encoder.png();
    }
    try {
      const { data, info } = await encoder.toBuffer({ resolveWithObject: true });
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
}
