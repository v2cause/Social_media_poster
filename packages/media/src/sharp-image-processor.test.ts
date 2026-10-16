import { crc32 } from 'node:zlib';

import { ImageRejectedError, type MediaRejectReason } from '@smp/core';
import { planRendition, RENDITION_PROFILES, type RenditionProfileKey } from '@smp/platform-rules';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { SharpImageProcessor } from './sharp-image-processor';

// Guide step 3.3 on generated images: the size after the EXIF orientation, new encodings without
// metadata in sRGB, and the images the pipeline refuses.

const processor = new SharpImageProcessor();

const solid = (width: number, height: number, alpha = 1) =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 60, b: 40, alpha } } });

/** A photo as a phone stores it: landscape pixels, upright by EXIF, with camera and GPS data. */
const phonePhoto = () =>
  solid(400, 300)
    .withExif({
      IFD0: { Make: 'Phone', Model: 'X1' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '50/1 56/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '6/1 57/1 0/1',
      },
    })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

/** The reason an image was refused with. */
async function rejectionOf(promise: Promise<unknown>): Promise<MediaRejectReason> {
  const error: unknown = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(ImageRejectedError);
  return (error as ImageRejectedError).reason;
}

describe('SharpImageProcessor', () => {
  it('measures the image as it is shown, after the EXIF orientation', async () => {
    const photo = await phonePhoto();
    expect(await sharp(photo).metadata()).toMatchObject({ width: 400, height: 300, orientation: 6 });

    await expect(processor.inspect(photo)).resolves.toEqual({
      format: 'jpeg',
      width: 300,
      height: 400,
      frames: 1,
    });
  });

  it('encodes upright images in sRGB without EXIF and GPS data', async () => {
    const encoded = await processor.encode(await phonePhoto(), {
      format: 'webp',
      quality: 80,
      maxWidth: 150,
      maxHeight: 600,
    });

    expect(encoded).toMatchObject({ mimeType: 'image/webp', width: 150, height: 200 });
    const metadata = await sharp(encoded.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 150, height: 200, space: 'srgb' });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('fits images into the box without enlarging them', async () => {
    const large = await solid(4000, 3000).png().toBuffer();
    const small = await solid(100, 50).png().toBuffer();
    const box = { format: 'webp', quality: 80, maxWidth: 640, maxHeight: 2560 } as const;

    await expect(processor.encode(large, box)).resolves.toMatchObject({ width: 640, height: 480 });
    await expect(processor.encode(small, box)).resolves.toMatchObject({ width: 100, height: 50 });
  });

  it('converts CMYK to sRGB and turns transparency white in JPEG', async () => {
    const cmyk = await solid(50, 50).toColourspace('cmyk').jpeg().toBuffer();
    const transparent = await solid(10, 10, 0).png().toBuffer();

    const fromCmyk = await processor.encode(cmyk, {
      format: 'webp',
      quality: 80,
      maxWidth: 50,
      maxHeight: 50,
    });
    const flattened = await processor.encode(transparent, {
      format: 'jpeg',
      quality: 85,
      maxWidth: 10,
      maxHeight: 10,
    });

    expect((await sharp(fromCmyk.bytes).metadata()).space).toBe('srgb');
    expect(flattened.mimeType).toBe('image/jpeg');
    const pixels = await sharp(flattened.bytes).raw().toBuffer();
    expect([...pixels.subarray(0, 3)].every((value) => value > 250)).toBe(true);
  });

  it('counts the frames of animations', async () => {
    const red = await solid(20, 20).png().toBuffer();
    const blue = await sharp({
      create: { width: 20, height: 20, channels: 4, background: '#0000ff' },
    })
      .png()
      .toBuffer();
    const animation = await sharp([red, blue], { join: { animated: true } })
      .gif()
      .toBuffer();

    await expect(processor.inspect(animation)).resolves.toMatchObject({ format: 'gif', frames: 2 });
  });

  it('refuses images above 50 megapixels from the header, before decoding them', async () => {
    // A 1x1 PNG whose header claims 10000 x 6000 pixels.
    const png = Buffer.from(await solid(1, 1).png().toBuffer());
    png.writeUInt32BE(10_000, 16);
    png.writeUInt32BE(6_000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)) >>> 0, 29);
    const box = { format: 'webp', quality: 80, maxWidth: 320, maxHeight: 1280 } as const;

    expect(await rejectionOf(processor.inspect(png))).toBe('DIMENSIONS_TOO_LARGE');
    expect(await rejectionOf(processor.encode(png, box))).toBe('DIMENSIONS_TOO_LARGE');
  });

  it('refuses corrupt and truncated images', async () => {
    const garbage = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 200 }, () => 7)]);
    const photo = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const truncated = photo.subarray(0, Math.floor(photo.byteLength / 2));
    const box = { format: 'webp', quality: 80, maxWidth: 320, maxHeight: 1280 } as const;

    expect(await rejectionOf(processor.inspect(garbage))).toBe('CORRUPT_IMAGE');
    // The header of a truncated file is intact; decoding the pixels fails.
    await expect(processor.inspect(truncated)).resolves.toMatchObject({ width: 400, height: 300 });
    expect(await rejectionOf(processor.encode(truncated, box))).toBe('CORRUPT_IMAGE');
  });

  it('hashes the bytes with SHA-256', () => {
    expect(processor.sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('renders the crop of the image as it is shown, after the EXIF orientation', async () => {
    // Landscape pixels, left half red, right half blue; orientation 6 shows red on top.
    const pixels = Buffer.alloc(400 * 300 * 3);
    for (let index = 0; index < 400 * 300; index += 1) {
      pixels[index * 3 + (index % 400 < 200 ? 0 : 2)] = 255;
    }
    const photo = await sharp(pixels, { raw: { width: 400, height: 300, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();

    const top = await processor.render(photo, {
      extract: { x: 0, y: 0, width: 300, height: 200 },
      resize: { width: 150, height: 100 },
      extend: { top: 10, right: 0, bottom: 10, left: 0 },
      format: 'jpeg',
      quality: 90,
    });

    expect(top).toMatchObject({ mimeType: 'image/jpeg', width: 150, height: 120 });
    const { data } = await sharp(top.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * 150 + x) * 3, (y * 150 + x) * 3 + 3)];
    // White bar above, red content below it.
    expect(pixel(75, 3).every((value) => value > 245)).toBe(true);
    const [red = 0, green = 0, blue = 0] = pixel(75, 60);
    expect(red).toBeGreaterThan(200);
    expect(Math.max(green, blue)).toBeLessThan(40);
    expect((await sharp(top.bytes).metadata()).exif).toBeUndefined();
  });

  it('keeps every platform rendition of a photo within the byte limit of its profile', async () => {
    // Photo-like: a gradient with grain, 4000 x 3000 pixels.
    const width = 4000;
    const height = 3000;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        const grain = ((x * 7919 + y * 104_729) % 23) - 11;
        pixels[index] = Math.max(0, Math.min(255, Math.round((x / width) * 200) + 30 + grain));
        pixels[index + 1] = Math.max(0, Math.min(255, Math.round((y / height) * 180) + 40 + grain));
        pixels[index + 2] = Math.max(0, Math.min(255, 120 + grain));
      }
    }
    const photo = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();
    const keys: RenditionProfileKey[] = ['instagram_feed', 'facebook_photo', 'linkedin_image', 'x_image'];

    for (const key of keys) {
      const profile = RENDITION_PROFILES[key];
      const planned = planRendition({ width, height }, { crop: null, letterbox: false }, profile);
      if (!planned.ok) {
        throw new Error(`no plan for ${key}`);
      }
      const rendition = await processor.render(photo, {
        ...planned.plan,
        format: profile.format,
        quality: profile.quality,
      });

      expect(rendition, key).toMatchObject({
        mimeType: 'image/jpeg',
        width: planned.plan.width,
        height: planned.plan.height,
      });
      expect(rendition.bytes.byteLength, key).toBeLessThanOrEqual(profile.maxBytes);
      expect((await sharp(rendition.bytes).metadata()).space, key).toBe('srgb');
    }
  });
});
