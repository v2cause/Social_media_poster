import { planRendition, renditionProfileFor, type MediaItem, type Platform } from '@smp/platform-rules';

import type { DraftMedia } from './composer-model';

// What the platform gets from the attached images (guide steps 3.4 and 3.6), with the same
// planRendition() as the media pipeline, so the composer warns about exactly what the server
// would refuse to render.

export interface RenderedSize {
  width: number;
  height: number;
  /** False when the image needs a crop or letterbox for the platform first. */
  fits: boolean;
}

/** The size of the rendition for the platform, or of the region as cropped when it does not fit. */
export function renderedSize(media: DraftMedia, platform: Platform): RenderedSize | null {
  const { width, height } = media.asset;
  if (!width || !height) {
    return null;
  }
  const planned = planRendition(
    { width, height },
    { crop: media.crop, letterbox: media.letterbox },
    renditionProfileFor(platform),
  );
  if (planned.ok) {
    return { width: planned.plan.width, height: planned.plan.height, fits: true };
  }
  const region = media.crop ?? { width, height };
  return { width: region.width, height: region.height, fits: false };
}

/** The media of a variant as validatePost() checks them: JPEG renditions at their planned size. */
export function mediaItemsFor(media: readonly DraftMedia[], platform: Platform): MediaItem[] {
  return media.map((item) => {
    const size = renderedSize(item, platform);
    return {
      kind: 'image',
      mimeType: 'image/jpeg',
      ...(size ? { width: size.width, height: size.height } : {}),
    };
  });
}
