import { WorkspaceNotFoundError, type ContentActor, type StoragePort } from '@smp/core';
import type { BrandVoiceView, IdeaView, PostView, VariantView } from '@smp/db';

import type { RequestAccess } from '../../common/guards/request-access';
import { toMediaAssetDto } from '../media/media.mappers';
import type { BrandVoiceDto, IdeaDto, PostDto, VariantDto } from './content.dto';

// Views of the read model to the response DTOs: timestamps as ISO strings, the media of variants
// with thumbnails behind signed URLs.

/** The acting member of a /w/:ws route. */
export function actorOf(access: RequestAccess): ContentActor {
  if (!access.workspaceId) {
    throw new WorkspaceNotFoundError();
  }
  return {
    userId: access.userId,
    organizationId: access.organizationId,
    workspaceId: access.workspaceId,
    role: access.role,
  };
}

export const refOf = (actor: ContentActor) => ({
  organizationId: actor.organizationId,
  workspaceId: actor.workspaceId,
});

export const toVariantDto = async (view: VariantView, storage: StoragePort): Promise<VariantDto> => ({
  ...view,
  media: await Promise.all(
    view.media.map(async (use) => ({ ...use, asset: await toMediaAssetDto(use.asset, storage) })),
  ),
  updatedAt: view.updatedAt.toISOString(),
});

export const toPostDto = async (view: PostView, storage: StoragePort): Promise<PostDto> => ({
  ...view,
  createdAt: view.createdAt.toISOString(),
  updatedAt: view.updatedAt.toISOString(),
  variants: await Promise.all(view.variants.map((variant) => toVariantDto(variant, storage))),
});

export const toBrandVoiceDto = (view: BrandVoiceView): BrandVoiceDto => ({
  ...view,
  updatedAt: view.updatedAt.toISOString(),
});

export const toIdeaDto = (view: IdeaView): IdeaDto => ({
  ...view,
  createdAt: view.createdAt.toISOString(),
});
