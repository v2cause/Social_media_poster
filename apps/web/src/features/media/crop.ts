import type { CropDto } from '@smp/contracts';
import type { Platform } from '@smp/platform-rules';

// Crops of the crop dialog (guide step 3.6). react-easy-crop reports the region in percent of the
// thumbnail it shows; the server keeps it in pixels of the original, as it is shown after the
// EXIF orientation. The presets per platform stay inside the ratios the platform accepts. The
// thumbnails show a crop as a window on the image, see coverOf.

export type CropPreset = 'portrait' | 'square' | 'landscape' | 'wide' | 'original';

export const PRESETS: Readonly<Record<Platform, readonly CropPreset[]>> = {
  INSTAGRAM: ['portrait', 'square', 'landscape'],
  FACEBOOK: ['landscape', 'square', 'portrait', 'original'],
  LINKEDIN: ['landscape', 'square', 'portrait', 'original'],
  X: ['wide', 'square', 'portrait', 'original'],
};

const RATIOS: Readonly<Record<Exclude<CropPreset, 'original'>, number>> = {
  portrait: 4 / 5,
  square: 1,
  landscape: 1.91,
  wide: 16 / 9,
};

export interface Size {
  width: number;
  height: number;
}

/** The width/height ratio of a preset; "original" keeps the ratio of the image. */
export const ratioOf = (preset: CropPreset, image: Size): number =>
  preset === 'original' ? image.width / image.height : RATIOS[preset];

/** A region in percent, as react-easy-crop reports and takes it. */
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * The crop in whole pixels of the original, always inside the image. With the ratio of the preset,
 * the crop keeps it as exactly as whole pixels allow: the cropper works on a thumbnail with rounded
 * sides, so its percentages can miss the ratio, which matters at the edge of the allowed range. The
 * crop only shrinks for that, so it stays inside the image.
 */
export function cropOf(area: Area, image: Size, ratio?: number): CropDto {
  const x = clamp(Math.round((area.x / 100) * image.width), 0, image.width - 1);
  const y = clamp(Math.round((area.y / 100) * image.height), 0, image.height - 1);
  let width = clamp(Math.round((area.width / 100) * image.width), 1, image.width - x);
  let height = clamp(Math.round((area.height / 100) * image.height), 1, image.height - y);
  if (ratio !== undefined) {
    if (width / height > ratio) {
      width = Math.max(1, Math.round(height * ratio));
    } else {
      height = Math.max(1, Math.round(width / ratio));
    }
  }
  return { x, y, width, height };
}

/** The area of a stored crop, to show it again. */
export const areaOf = (crop: CropDto, image: Size): Area => ({
  x: (crop.x / image.width) * 100,
  y: (crop.y / image.height) * 100,
  width: (crop.width / image.width) * 100,
  height: (crop.height / image.height) * 100,
});

/** The preset whose ratio is closest to the crop; the first one of the platform without a crop. */
export function presetOf(crop: CropDto | null, platform: Platform, image: Size): CropPreset {
  const presets = PRESETS[platform];
  const first = presets[0] ?? 'square';
  if (!crop) {
    return first;
  }
  const ratio = crop.width / crop.height;
  return presets.reduce(
    (best, preset) =>
      Math.abs(ratioOf(preset, image) - ratio) < Math.abs(ratioOf(best, image) - ratio) ? preset : best,
    first,
  );
}

/**
 * The middle of a region that fills a frame of another ratio, as object-fit: cover would: the
 * window a thumbnail shows of a crop, without stretching it. In the units of the region.
 */
export function coverOf(region: Area, ratio: number): Area {
  if (ratio > region.width / region.height) {
    const height = region.width / ratio;
    return { ...region, y: region.y + (region.height - height) / 2, height };
  }
  const width = region.height * ratio;
  return { ...region, x: region.x + (region.width - width) / 2, width };
}
