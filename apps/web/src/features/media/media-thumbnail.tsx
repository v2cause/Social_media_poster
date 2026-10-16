import type { CropDto, MediaAssetDto } from '@smp/contracts';
import { cn } from '@smp/ui';

import { coverOf } from './crop';

// Thumbnails behind signed URLs (guide step 3.6); the original is never shown. A crop shows as a
// window on the thumbnail, so previews need no rendition of their own. Plain <img> on purpose:
// the URLs are signed for one hour, and the image optimizer of Next.js would cache and serve them
// from its own origin past that.

const srcSetOf = (asset: MediaAssetDto): string | undefined =>
  asset.thumbnails.length > 0
    ? asset.thumbnails.map((thumbnail) => `${thumbnail.url} ${String(thumbnail.width)}w`).join(', ')
    : undefined;

export function MediaThumbnail(props: {
  asset: MediaAssetDto;
  /** The region to show, in pixels of the original. */
  crop?: CropDto | null;
  /** White bars around the image instead of cutting it: contain instead of cover. */
  letterbox?: boolean;
  alt: string;
  /** Width/height of the frame; the image fills it. Without, the frame takes the image's ratio. */
  aspectRatio?: number;
  sizes?: string;
  className?: string;
}) {
  const { asset, crop } = props;
  const first = asset.thumbnails[0];
  if (!first) {
    return <div aria-hidden="true" className={cn('bg-muted', props.className)} />;
  }
  const largest = asset.thumbnails.at(-1) ?? first;
  const width = asset.width ?? largest.width;
  const height = asset.height ?? largest.height;
  const ratio = props.aspectRatio ?? (crop ? crop.width / crop.height : width / height);

  if (crop && !props.letterbox) {
    // Scale the whole image so that the crop fills the frame, then move the crop into view. A
    // frame of another ratio shows the middle of the crop instead of stretching it.
    const view = coverOf(crop, ratio);
    const scaleX = width / view.width;
    const scaleY = height / view.height;
    return (
      <div
        className={cn('relative overflow-hidden bg-muted', props.className)}
        style={{ aspectRatio: String(ratio) }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs, see above */}
        <img
          src={largest.url}
          srcSet={srcSetOf(asset)}
          sizes={props.sizes}
          alt={props.alt}
          className="absolute max-w-none"
          style={{
            width: `${String(scaleX * 100)}%`,
            height: `${String(scaleY * 100)}%`,
            left: `${String((-view.x / view.width) * 100)}%`,
            top: `${String((-view.y / view.height) * 100)}%`,
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={cn('overflow-hidden', props.letterbox ? 'bg-white' : 'bg-muted', props.className)}
      style={{ aspectRatio: String(ratio) }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs, see above */}
      <img
        src={largest.url}
        srcSet={srcSetOf(asset)}
        sizes={props.sizes}
        alt={props.alt}
        className={cn('size-full', props.letterbox ? 'object-contain' : 'object-cover')}
      />
    </div>
  );
}
