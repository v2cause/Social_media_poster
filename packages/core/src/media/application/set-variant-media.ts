import { cropFits, planRendition, renditionProfileFor } from '@smp/platform-rules';

import { VariantLockedError, VariantNotFoundError, VersionConflictError } from '../../content/domain/errors';
import { isVariantEditable } from '../../content/domain/rules';
import type { ContentActor } from '../../content/domain/types';
import {
  CropOutOfBoundsError,
  MediaNotFoundError,
  MediaNotReadyError,
  VariantMediaInvalidError,
} from '../domain/errors';
import { cropHashOf, MAX_VARIANT_MEDIA } from '../domain/rules';
import type { Crop, MediaAsset, PostMedia } from '../domain/types';
import type { RenderJob } from '../ports/media-jobs';
import { assertCanWriteMedia, mediaScopeOf, type MediaDependencies } from './dependencies';

// The media of a variant (guide step 3.4): which assets, in which order, with crop, letterbox and
// alt text per use. Saved with the version of the variant like its text. The renditions for the
// platform are queued right away; one that does not fit the aspect ratio yet waits for a crop
// or letterbox, and the composer shows why.

export interface VariantMediaItem {
  assetId: string;
  crop: Crop | null;
  letterbox: boolean;
  altText: string | null;
}

export interface SetVariantMediaInput {
  actor: ContentActor;
  variantId: string;
  /** The version of the variant the client last read. */
  version: number;
  items: readonly VariantMediaItem[];
}

export class SetVariantMedia {
  constructor(private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'jobs' | 'ids'>) {}

  async execute(input: SetVariantMediaInput): Promise<void> {
    const { actor } = input;
    assertCanWriteMedia(actor);
    const assetIds = input.items.map((item) => item.assetId);
    if (assetIds.length > MAX_VARIANT_MEDIA || new Set(assetIds).size !== assetIds.length) {
      throw new VariantMediaInvalidError();
    }

    const { platform, attached } = await this.deps.unitOfWork.run(mediaScopeOf(actor), async (store) => {
      const variant = await store.variants.find(actor.workspaceId, input.variantId);
      if (!variant) {
        throw new VariantNotFoundError();
      }
      if (!isVariantEditable(variant.status)) {
        throw new VariantLockedError();
      }
      if (variant.version !== input.version) {
        throw new VersionConflictError();
      }
      const assets: MediaAsset[] = [];
      for (const item of input.items) {
        const asset = await store.assets.find(actor.workspaceId, item.assetId);
        if (!asset || asset.deletedAt !== null) {
          throw new MediaNotFoundError();
        }
        if (asset.status !== 'READY' || asset.width === null || asset.height === null) {
          throw new MediaNotReadyError();
        }
        if (item.crop && !cropFits(item.crop, { width: asset.width, height: asset.height })) {
          throw new CropOutOfBoundsError();
        }
        assets.push(asset);
      }
      if (!(await store.variants.touch(actor.workspaceId, variant.id, input.version))) {
        throw new VersionConflictError();
      }
      const media: PostMedia[] = input.items.map((item, position) => ({
        id: this.deps.ids.newId(),
        workspaceId: actor.workspaceId,
        variantId: variant.id,
        assetId: item.assetId,
        position,
        crop: item.crop,
        letterbox: item.letterbox,
        altText: item.altText?.trim() ? item.altText.trim() : null,
      }));
      await store.postMedia.replace(actor.workspaceId, variant.id, media);
      return {
        platform: variant.platform,
        attached: media.map((use, index) => ({ use, asset: assets[index] })),
      };
    });

    const profile = renditionProfileFor(platform);
    for (const { use, asset } of attached) {
      if (!asset?.width || !asset.height) {
        continue;
      }
      const options = { crop: use.crop, letterbox: use.letterbox };
      if (!planRendition({ width: asset.width, height: asset.height }, options, profile).ok) {
        continue;
      }
      const job: RenderJob = {
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        assetId: use.assetId,
        postMediaId: use.id,
        profile: profile.key,
        cropHash: cropHashOf(use.crop, use.letterbox),
      };
      await this.deps.jobs.render(job);
    }
  }
}
