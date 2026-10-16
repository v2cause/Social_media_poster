import { describe, expect, it } from 'vitest';

import {
  planRendition,
  RENDITION_PROFILE_KEYS,
  RENDITION_PROFILES,
  renditionProfileFor,
  type RenditionPlan,
  type RenditionProfileKey,
} from '.';

// Guide step 3.4, "Fertig, wenn": for every profile the sizes of the result and its limits.

const MB = 1024 * 1024;
const whole = { crop: null, letterbox: false };

/** The size of the result, or the issue. */
function sizeOf(
  key: RenditionProfileKey,
  image: { width: number; height: number },
  options: { crop: RenditionPlan['extract']; letterbox: boolean } = whole,
): [number, number] | string {
  const result = planRendition(image, options, RENDITION_PROFILES[key]);
  return result.ok ? [result.plan.width, result.plan.height] : result.issue;
}

describe('rendition profiles', () => {
  it('maps every platform to its profile', () => {
    expect(renditionProfileFor('INSTAGRAM').key).toBe('instagram_feed');
    expect(renditionProfileFor('FACEBOOK').key).toBe('facebook_photo');
    expect(renditionProfileFor('LINKEDIN').key).toBe('linkedin_image');
    expect(renditionProfileFor('X').key).toBe('x_image');
    expect(Object.keys(RENDITION_PROFILES).sort()).toEqual([...RENDITION_PROFILE_KEYS].sort());
  });

  it('instagram_feed: JPEG of at most 8 MB, 1080 wide, 4:5 to 1.91:1, at least 320 wide', () => {
    expect(RENDITION_PROFILES.instagram_feed).toMatchObject({
      format: 'jpeg',
      quality: 85,
      maxBytes: 8 * MB,
    });
    expect(sizeOf('instagram_feed', { width: 4000, height: 5000 })).toEqual([1080, 1350]);
    expect(sizeOf('instagram_feed', { width: 6000, height: 4000 })).toEqual([1080, 720]);
    expect(sizeOf('instagram_feed', { width: 3820, height: 2000 })).toEqual([1080, 565]);
    expect(sizeOf('instagram_feed', { width: 800, height: 800 })).toEqual([800, 800]);
    // Instagram scales narrower images up to 320; the rendition does it already.
    expect(sizeOf('instagram_feed', { width: 200, height: 250 })).toEqual([320, 400]);
    expect(sizeOf('instagram_feed', { width: 3000, height: 4000 })).toBe('ASPECT_RATIO_OUT_OF_RANGE');
    expect(sizeOf('instagram_feed', { width: 3000, height: 1000 })).toBe('ASPECT_RATIO_OUT_OF_RANGE');
  });

  it('instagram_feed: fits other ratios with a crop or white bars', () => {
    const portrait = { width: 3000, height: 4000 };
    expect(
      sizeOf('instagram_feed', portrait, {
        crop: { x: 0, y: 250, width: 3000, height: 3750 },
        letterbox: false,
      }),
    ).toEqual([1080, 1350]);

    const letterboxed = planRendition(
      portrait,
      { crop: null, letterbox: true },
      RENDITION_PROFILES.instagram_feed,
    );
    expect(letterboxed).toEqual({
      ok: true,
      plan: {
        extract: null,
        resize: { width: 1013, height: 1350 },
        extend: { top: 0, bottom: 0, left: 33, right: 34 },
        width: 1080,
        height: 1350,
      },
    });

    const panorama = planRendition(
      { width: 3000, height: 1000 },
      { crop: null, letterbox: true },
      RENDITION_PROFILES.instagram_feed,
    );
    expect(panorama).toMatchObject({
      ok: true,
      plan: { resize: { width: 1080, height: 360 }, extend: { top: 103, bottom: 103, left: 0, right: 0 } },
    });
    if (panorama.ok) {
      expect(panorama.plan.width / panorama.plan.height).toBeCloseTo(1.91, 2);
    }
  });

  it('facebook_photo: JPEG of at most 4 MB, at most 2048 on the longest side', () => {
    expect(RENDITION_PROFILES.facebook_photo).toMatchObject({ format: 'jpeg', maxBytes: 4 * MB });
    expect(sizeOf('facebook_photo', { width: 6000, height: 4000 })).toEqual([2048, 1365]);
    expect(sizeOf('facebook_photo', { width: 3000, height: 9000 })).toEqual([683, 2048]);
    expect(sizeOf('facebook_photo', { width: 1200, height: 630 })).toEqual([1200, 630]);
  });

  it('linkedin_image: JPEG of at most 5 MB, well below 36,152,320 pixels', () => {
    expect(RENDITION_PROFILES.linkedin_image).toMatchObject({ format: 'jpeg', maxBytes: 5 * MB });
    const size = sizeOf('linkedin_image', { width: 12_000, height: 9_000 });
    expect(size).toEqual([2048, 1536]);
    expect(Array.isArray(size) ? size[0] * size[1] : Infinity).toBeLessThan(36_152_320);
    expect(sizeOf('linkedin_image', { width: 1080, height: 1080 })).toEqual([1080, 1080]);
  });

  it('x_image: JPEG of at most 5 MB, at most 4096 on the longest side', () => {
    expect(RENDITION_PROFILES.x_image).toMatchObject({ format: 'jpeg', maxBytes: 5 * MB });
    expect(sizeOf('x_image', { width: 8000, height: 6000 })).toEqual([4096, 3072]);
    expect(sizeOf('x_image', { width: 1600, height: 900 })).toEqual([1600, 900]);
  });

  it('thumb_320 and thumb_640: WebP thumbnails, never more than four times as high as wide', () => {
    expect(RENDITION_PROFILES.thumb_320).toMatchObject({ format: 'webp', quality: 80, maxBytes: 1 * MB });
    expect(RENDITION_PROFILES.thumb_640).toMatchObject({ format: 'webp', quality: 80, maxBytes: 2 * MB });
    expect(sizeOf('thumb_320', { width: 4000, height: 3000 })).toEqual([320, 240]);
    expect(sizeOf('thumb_320', { width: 100, height: 10_000 })).toEqual([13, 1280]);
    expect(sizeOf('thumb_640', { width: 4000, height: 3000 })).toEqual([640, 480]);
    expect(sizeOf('thumb_640', { width: 300, height: 200 })).toEqual([300, 200]);
  });

  it('ai_vision: JPEG of at most 3 MB, at most 1568 on the longest side', () => {
    expect(RENDITION_PROFILES.ai_vision).toMatchObject({ format: 'jpeg', maxBytes: 3 * MB });
    expect(sizeOf('ai_vision', { width: 4000, height: 3000 })).toEqual([1568, 1176]);
    expect(sizeOf('ai_vision', { width: 3000, height: 4000 })).toEqual([1176, 1568]);
    expect(sizeOf('ai_vision', { width: 1000, height: 700 })).toEqual([1000, 700]);
  });

  it('cuts out crops inside the image only', () => {
    const image = { width: 1000, height: 800 };
    const crop = { x: 100, y: 50, width: 600, height: 600 };

    expect(planRendition(image, { crop, letterbox: false }, RENDITION_PROFILES.x_image)).toEqual({
      ok: true,
      plan: { extract: crop, resize: { width: 600, height: 600 }, extend: null, width: 600, height: 600 },
    });
    for (const outside of [
      { x: 500, y: 0, width: 600, height: 100 },
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0.5, y: 0, width: 10, height: 10 },
    ]) {
      expect(sizeOf('x_image', image, { crop: outside, letterbox: false })).toBe('CROP_OUT_OF_BOUNDS');
    }
  });
});
