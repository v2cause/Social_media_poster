import { planRendition, renditionProfileFor, type Platform } from '@smp/platform-rules';
import { describe, expect, it } from 'vitest';

import { areaOf, coverOf, cropOf, nudge, NUDGE_STEP, PRESETS, presetOf, ratioOf } from './crop';

const image = { width: 4000, height: 3000 };

describe('crops of the crop dialog', () => {
  it('turns percent of the thumbnail into whole pixels inside the original', () => {
    expect(cropOf({ x: 12.5, y: 0, width: 60, height: 100 }, image)).toEqual({
      x: 500,
      y: 0,
      width: 2400,
      height: 3000,
    });
    // Rounding never leaves the image.
    expect(cropOf({ x: 99.99, y: 99.99, width: 5, height: 5 }, image)).toEqual({
      x: 3999,
      y: 2999,
      width: 1,
      height: 1,
    });
    expect(areaOf({ x: 500, y: 0, width: 2400, height: 3000 }, image)).toEqual({
      x: 12.5,
      y: 0,
      width: 60,
      height: 100,
    });
  });

  it('keeps the ratio of the preset although the thumbnail of the cropper is rounded', () => {
    // 6000 x 520 has a thumbnail of 640 x 55; its 4:5 crop of 44 x 55 misses 4:5 in the original.
    const panorama = { width: 6000, height: 520 };
    const area = { x: 40, y: 0, width: (44 / 640) * 100, height: 100 };
    const instagram = renditionProfileFor('INSTAGRAM');
    const unsnapped = cropOf(area, panorama);
    expect(unsnapped).toEqual({ x: 2400, y: 0, width: 413, height: 520 });
    expect(planRendition(panorama, { crop: unsnapped, letterbox: false }, instagram).ok).toBe(false);

    const crop = cropOf(area, panorama, 4 / 5);
    expect(crop).toEqual({ x: 2400, y: 0, width: 413, height: 516 });
    expect(planRendition(panorama, { crop, letterbox: false }, instagram).ok).toBe(true);
    // A crop wider than the ratio loses width instead.
    expect(cropOf({ x: 0, y: 0, width: 50, height: 50 }, image, 1)).toEqual({
      x: 0,
      y: 0,
      width: 1500,
      height: 1500,
    });
  });

  it('offers only ratios the platform accepts, so every preset crop can be rendered', () => {
    for (const platform of Object.keys(PRESETS) as Platform[]) {
      for (const preset of PRESETS[platform]) {
        const ratio = ratioOf(preset, image);
        const height = 2000;
        const crop = cropOf(
          {
            x: 0,
            y: 0,
            width: ((height * ratio) / image.width) * 100,
            height: (height / image.height) * 100,
          },
          image,
        );
        expect(
          planRendition(image, { crop, letterbox: false }, renditionProfileFor(platform)).ok,
          `${platform} ${preset}`,
        ).toBe(true);
      }
    }
  });

  it('finds the preset of a stored crop again', () => {
    expect(presetOf(null, 'INSTAGRAM', image)).toBe('portrait');
    expect(presetOf({ x: 0, y: 0, width: 1000, height: 1000 }, 'INSTAGRAM', image)).toBe('square');
    expect(presetOf({ x: 0, y: 0, width: 1910, height: 1000 }, 'INSTAGRAM', image)).toBe('landscape');
    expect(presetOf({ x: 0, y: 0, width: 1600, height: 900 }, 'X', image)).toBe('wide');
  });

  it('shows the middle of a crop in a frame of another ratio instead of stretching it', () => {
    const portrait = { x: 100, y: 0, width: 800, height: 1000 };
    // A square frame shows the middle 800 x 800 of the 4:5 crop.
    expect(coverOf(portrait, 1)).toEqual({ x: 100, y: 100, width: 800, height: 800 });
    // A tall frame shows its middle columns.
    expect(coverOf({ x: 0, y: 0, width: 1000, height: 1000 }, 0.5)).toEqual({
      x: 250,
      y: 0,
      width: 500,
      height: 1000,
    });
    expect(coverOf(portrait, 0.8)).toEqual(portrait);
  });

  it('moves the image a step per button and keeps it over the whole crop area', () => {
    const sizes = { media: { width: 600, height: 400 }, crop: { width: 400, height: 400 }, zoom: 1 };
    expect(nudge({ x: 0, y: 0 }, 'right', sizes)).toEqual({ x: NUDGE_STEP, y: 0 });
    expect(nudge({ x: 0, y: 0 }, 'left', sizes)).toEqual({ x: -NUDGE_STEP, y: 0 });
    // At most half of what the image is wider than the crop area, so no empty edge shows.
    expect(nudge({ x: 95, y: 0 }, 'right', sizes)).toEqual({ x: 100, y: 0 });
    // The image is exactly as high as the crop area: it cannot move up or down.
    expect(nudge({ x: 0, y: 0 }, 'down', sizes)).toEqual({ x: 0, y: 0 });
    // Zoomed in, there is room in every direction.
    expect(nudge({ x: 0, y: 0 }, 'up', { ...sizes, zoom: 2 })).toEqual({ x: 0, y: -NUDGE_STEP });
  });
});
