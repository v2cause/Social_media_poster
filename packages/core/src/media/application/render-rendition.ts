import {
  planRendition,
  RENDITION_PROFILES,
  type RenditionPlan,
  type RenditionProfile,
  type RenditionProfileKey,
} from '@smp/platform-rules';

import {
  MediaNotFoundError,
  MediaNotReadyError,
  RenditionNotPossibleError,
  RenditionTooLargeError,
} from '../domain/errors';
import { cropHashOf, MAX_UPLOAD_BYTES } from '../domain/rules';
import { renditionKey } from '../domain/storage-keys';
import type { Crop, MediaRendition } from '../domain/types';
import type { EncodedImage } from '../ports/image-processor';
import type { MediaScope } from '../ports/media-store';
import type { MediaDependencies } from './dependencies';

// Makes sure the rendition of an asset for a profile and crop exists (guide step 3.4): when media
// are attached (media.render) and again before a post goes out (phase 4). A rendition that exists
// is returned as it is; key (asset, profile, crop hash).

export interface RenderRenditionInput {
  organizationId: string;
  workspaceId: string;
  assetId: string;
  profile: RenditionProfileKey;
  crop: Crop | null;
  letterbox: boolean;
}

const EXTENSIONS = { jpeg: 'jpg', webp: 'webp' } as const;

/** Lower qualities first, then smaller sizes, until the file fits the byte limit of the profile. */
const QUALITY_STEPS = [0, -10, -20] as const;
const SIZE_STEPS = [0.75, 0.5] as const;
const MIN_QUALITY = 50;

const scaled = (plan: RenditionPlan, factor: number): RenditionPlan => {
  const round = (value: number): number => Math.max(1, Math.round(value * factor));
  const extend = plan.extend && {
    top: Math.round(plan.extend.top * factor),
    right: Math.round(plan.extend.right * factor),
    bottom: Math.round(plan.extend.bottom * factor),
    left: Math.round(plan.extend.left * factor),
  };
  const resize = { width: round(plan.resize.width), height: round(plan.resize.height) };
  return {
    extract: plan.extract,
    resize,
    extend,
    width: resize.width + (extend ? extend.left + extend.right : 0),
    height: resize.height + (extend ? extend.top + extend.bottom : 0),
  };
};

export class RenderRendition {
  constructor(
    private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'processor' | 'ids'>,
  ) {}

  async execute(input: RenderRenditionInput): Promise<MediaRendition> {
    const scope: MediaScope = {
      userId: null,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
    };
    const profile = RENDITION_PROFILES[input.profile];
    const cropHash = cropHashOf(input.crop, input.letterbox);
    const { asset, existing } = await this.deps.unitOfWork.run(scope, async (store) => ({
      asset: await store.assets.find(input.workspaceId, input.assetId),
      existing: await store.renditions.find(input.workspaceId, input.assetId, profile.key, cropHash),
    }));
    if (!asset || asset.deletedAt !== null) {
      throw new MediaNotFoundError();
    }
    if (existing) {
      return existing;
    }
    if (asset.status !== 'READY' || asset.width === null || asset.height === null) {
      throw new MediaNotReadyError();
    }
    const planned = planRendition(
      { width: asset.width, height: asset.height },
      { crop: input.crop, letterbox: input.letterbox },
      profile,
    );
    if (!planned.ok) {
      throw new RenditionNotPossibleError(planned.issue);
    }

    const original = await this.deps.storage.get(asset.storageKey, { maxBytes: MAX_UPLOAD_BYTES });
    const encoded = await this.encodeWithinLimit(original, planned.plan, profile);
    const rendition: MediaRendition = {
      id: this.deps.ids.newId(),
      workspaceId: asset.workspaceId,
      assetId: asset.id,
      profile: profile.key,
      cropHash,
      storageKey: renditionKey(asset.workspaceId, asset.id, {
        profile: profile.key,
        cropHash,
        extension: EXTENSIONS[profile.format],
      }),
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      sizeBytes: encoded.bytes.byteLength,
    };
    await this.deps.storage.put(rendition.storageKey, encoded.bytes, { contentType: encoded.mimeType });
    await this.deps.unitOfWork.run(scope, (store) => store.renditions.upsert(rendition));
    return rendition;
  }

  private async encodeWithinLimit(
    original: Uint8Array,
    plan: RenditionPlan,
    profile: RenditionProfile,
  ): Promise<EncodedImage> {
    const attempts = [
      ...QUALITY_STEPS.map((step) => ({ plan, quality: Math.max(MIN_QUALITY, profile.quality + step) })),
      ...SIZE_STEPS.map((factor) => ({ plan: scaled(plan, factor), quality: MIN_QUALITY })),
    ];
    for (const attempt of attempts) {
      const encoded = await this.deps.processor.render(original, {
        extract: attempt.plan.extract,
        resize: attempt.plan.resize,
        extend: attempt.plan.extend,
        format: profile.format,
        quality: attempt.quality,
      });
      if (encoded.bytes.byteLength <= profile.maxBytes) {
        return encoded;
      }
    }
    throw new RenditionTooLargeError(profile.key);
  }
}
