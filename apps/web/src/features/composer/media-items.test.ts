import type { MediaAssetDto } from '@smp/contracts';
import { validatePost } from '@smp/platform-rules';
import { describe, expect, it } from 'vitest';

import type { DraftMedia } from './composer-model';
import { mediaItemsFor, renderedSize } from './media-items';

const media = (width: number, height: number, change: Partial<DraftMedia> = {}): DraftMedia => ({
  assetId: `${String(width)}x${String(height)}`,
  crop: null,
  letterbox: false,
  altText: null,
  asset: {
    id: 'asset',
    status: 'READY',
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    width,
    height,
    rejectReason: null,
    altText: null,
    usageCount: 0,
    thumbnails: [],
    version: 2,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
  } satisfies MediaAssetDto,
  ...change,
});

describe('media of a variant', () => {
  it('plans the size the platform gets', () => {
    expect(renderedSize(media(4000, 5000), 'INSTAGRAM')).toEqual({ width: 1080, height: 1350, fits: true });
    expect(renderedSize(media(3000, 1000), 'INSTAGRAM')).toEqual({ width: 3000, height: 1000, fits: false });
    expect(renderedSize(media(3000, 1000, { letterbox: true }), 'INSTAGRAM')).toEqual({
      width: 1080,
      height: 566,
      fits: true,
    });
    expect(renderedSize(media(3000, 1000), 'X')).toEqual({ width: 3000, height: 1000, fits: true });
  });

  it('warns about what Instagram would refuse until it is cropped', () => {
    const panorama = media(3000, 1000);
    const cropped = media(3000, 1000, { crop: { x: 1000, y: 0, width: 1000, height: 1000 } });
    const check = (items: DraftMedia[]) =>
      validatePost({ platform: 'INSTAGRAM', text: 'x', media: mediaItemsFor(items, 'INSTAGRAM') }).map(
        (issue) => issue.code,
      );

    expect(check([])).toEqual(['MEDIA_REQUIRED']);
    expect(check([panorama])).toEqual(['ASPECT_RATIO_OUT_OF_RANGE']);
    expect(check([cropped])).toEqual([]);
    expect(check([cropped, media(4000, 5000)])).toEqual(['MIXED_ASPECT_RATIOS']);
  });

  it('counts the images against the limit of X', () => {
    const five = Array.from({ length: 5 }, () => media(1600, 900));
    expect(validatePost({ platform: 'X', text: 'x', media: mediaItemsFor(five, 'X') })).toEqual([
      { code: 'TOO_MANY_MEDIA', limit: 4, actual: 5 },
    ]);
  });
});
