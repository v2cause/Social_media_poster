import type { Platform } from './platforms';

// Rendition profiles of the media pipeline (guide step 3.4, architecture 9): the file each
// platform gets from an image, and the WebP thumbnails of the library. planRendition() turns an
// image, its crop and the letterbox choice into the steps of the encoder; the composer uses the
// same function for its warnings and previews, so it runs in the browser too.

export const RENDITION_PROFILE_KEYS = [
  'instagram_feed',
  'facebook_photo',
  'linkedin_image',
  'x_image',
  'thumb_320',
  'thumb_640',
] as const;
export type RenditionProfileKey = (typeof RENDITION_PROFILE_KEYS)[number];

export interface RenditionProfile {
  key: RenditionProfileKey;
  format: 'jpeg' | 'webp';
  /** 1 to 100; lowered step by step when the file would exceed maxBytes. */
  quality: number;
  /** The image fits into this box and is never enlarged beyond it. */
  maxWidth: number;
  maxHeight: number;
  /** Narrower images are enlarged to this width. */
  minWidth?: number;
  /** Allowed width/height ratio; outside of it the user crops or picks letterbox. */
  aspectRatio?: { min: number; max: number };
  maxBytes: number;
}

const MB = 1024 * 1024;

export const RENDITION_PROFILES: Readonly<Record<RenditionProfileKey, RenditionProfile>> = {
  // JPEG only, at most 8 MB, ratio 4:5 to 1.91:1, width 320 to 1440 (narrower ones are scaled up,
  // wider ones down), converted to sRGB. Checked 2026-10-16 through the search index of
  // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
  // (the page itself is not reachable from this environment). 1080 is the width the feed shows.
  instagram_feed: {
    key: 'instagram_feed',
    format: 'jpeg',
    quality: 85,
    maxWidth: 1080,
    // 4:5 at the full width.
    maxHeight: 1350,
    minWidth: 320,
    aspectRatio: { min: 4 / 5, max: 1.91 },
    maxBytes: 8 * MB,
  },
  // "Photos should be less than 4 MB" (error text of the Graph API, quoted in Meta's developer
  // community). No pixel limit is documented; 2048 px on the longest side is the size Facebook
  // keeps. Not confirmed from this environment; re-check in phase 4b.
  facebook_photo: {
    key: 'facebook_photo',
    format: 'jpeg',
    quality: 85,
    maxWidth: 2048,
    maxHeight: 2048,
    maxBytes: 4 * MB,
  },
  // Images API: JPG, GIF or PNG below 36,152,320 pixels; 5 MB after secondary sources only.
  // Not confirmed from this environment; re-check in phase 4a.
  linkedin_image: {
    key: 'linkedin_image',
    format: 'jpeg',
    quality: 85,
    maxWidth: 2048,
    maxHeight: 2048,
    maxBytes: 5 * MB,
  },
  // Images in JPG, PNG, GIF or WEBP of at most 5 MB. Checked 2026-10-16 through the search index
  // of https://docs.x.com/x-api/media/introduction; 4096 px is the largest side X keeps.
  x_image: {
    key: 'x_image',
    format: 'jpeg',
    quality: 85,
    maxWidth: 4096,
    maxHeight: 4096,
    maxBytes: 5 * MB,
  },
  // Thumbnails of the library and the previews; four times as high as wide at most.
  thumb_320: {
    key: 'thumb_320',
    format: 'webp',
    quality: 80,
    maxWidth: 320,
    maxHeight: 1280,
    maxBytes: 1 * MB,
  },
  thumb_640: {
    key: 'thumb_640',
    format: 'webp',
    quality: 80,
    maxWidth: 640,
    maxHeight: 2560,
    maxBytes: 2 * MB,
  },
};

const PLATFORM_PROFILES: Readonly<Record<Platform, RenditionProfileKey>> = {
  INSTAGRAM: 'instagram_feed',
  FACEBOOK: 'facebook_photo',
  LINKEDIN: 'linkedin_image',
  X: 'x_image',
};

/** The profile of the images a platform gets. */
export const renditionProfileFor = (platform: Platform): RenditionProfile =>
  RENDITION_PROFILES[PLATFORM_PROFILES[platform]];

/** A region in pixels of the image as it is shown, after the EXIF orientation. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenditionPlan {
  /** The region to cut out first; null for the whole image. */
  extract: Crop | null;
  /** The size of the image content after scaling. */
  resize: { width: number; height: number };
  /** White bars around the content (letterbox), in pixels of the result; null for none. */
  extend: { top: number; right: number; bottom: number; left: number } | null;
  /** The size of the result. */
  width: number;
  height: number;
}

export type RenditionPlanIssue = 'CROP_OUT_OF_BOUNDS' | 'ASPECT_RATIO_OUT_OF_RANGE';

export type RenditionPlanResult =
  { ok: true; plan: RenditionPlan } | { ok: false; issue: RenditionPlanIssue };

// Rounded pixel sizes such as 1080 x 566 for 1.91:1 should pass.
export const ASPECT_RATIO_TOLERANCE = 0.005;

const isWholeNumber = (value: number, min: number): boolean => Number.isInteger(value) && value >= min;

/** True if the crop lies inside an image of this size. */
export function cropFits(crop: Crop, image: { width: number; height: number }): boolean {
  return (
    isWholeNumber(crop.x, 0) &&
    isWholeNumber(crop.y, 0) &&
    isWholeNumber(crop.width, 1) &&
    isWholeNumber(crop.height, 1) &&
    crop.x + crop.width <= image.width &&
    crop.y + crop.height <= image.height
  );
}

/** True if the width/height ratio is allowed, with tolerance for rounded pixel sizes. */
export const ratioFits = (ratio: number, range: { min: number; max: number }): boolean =>
  ratio >= range.min - ASPECT_RATIO_TOLERANCE && ratio <= range.max + ASPECT_RATIO_TOLERANCE;

/**
 * The steps that turn an image into the rendition of a profile: cut out the crop, scale it into
 * the box of the profile, and with letterbox add white bars up to the nearest allowed ratio.
 * Without letterbox, a region outside the allowed ratio cannot be rendered.
 */
export function planRendition(
  image: { width: number; height: number },
  options: { crop: Crop | null; letterbox: boolean },
  profile: RenditionProfile,
): RenditionPlanResult {
  const region = options.crop ?? { x: 0, y: 0, width: image.width, height: image.height };
  if (!cropFits(region, image)) {
    return { ok: false, issue: 'CROP_OUT_OF_BOUNDS' };
  }

  // The canvas in pixels of the source: the region, widened or heightened by the bars.
  let canvas = { width: region.width, height: region.height };
  const ratio = region.width / region.height;
  const range = profile.aspectRatio;
  if (range && !ratioFits(ratio, range)) {
    if (!options.letterbox) {
      return { ok: false, issue: 'ASPECT_RATIO_OUT_OF_RANGE' };
    }
    canvas =
      ratio < range.min
        ? { width: Math.ceil(region.height * range.min), height: region.height }
        : { width: region.width, height: Math.ceil(region.width / range.max) };
  }

  let scale = Math.min(1, profile.maxWidth / canvas.width, profile.maxHeight / canvas.height);
  if (profile.minWidth !== undefined && canvas.width * scale < profile.minWidth) {
    scale = profile.minWidth / canvas.width;
  }
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const content = {
    width: Math.min(width, Math.max(1, Math.round(region.width * scale))),
    height: Math.min(height, Math.max(1, Math.round(region.height * scale))),
  };
  const padX = width - content.width;
  const padY = height - content.height;
  const extend =
    padX > 0 || padY > 0
      ? {
          top: Math.floor(padY / 2),
          bottom: padY - Math.floor(padY / 2),
          left: Math.floor(padX / 2),
          right: padX - Math.floor(padX / 2),
        }
      : null;

  return {
    ok: true,
    plan: { extract: options.crop, resize: content, extend, width, height },
  };
}
