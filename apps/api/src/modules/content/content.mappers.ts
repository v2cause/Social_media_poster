import { WorkspaceNotFoundError, type ContentActor } from '@smp/core';
import type { BrandVoiceView, IdeaView, PostView, VariantView } from '@smp/db';

import type { RequestAccess } from '../../common/guards/request-access';
import type { BrandVoiceDto, IdeaDto, PostDto, VariantDto } from './content.dto';

// Views of the read model to the response DTOs: timestamps as ISO strings.

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

export const toVariantDto = (view: VariantView): VariantDto => ({
  ...view,
  updatedAt: view.updatedAt.toISOString(),
});

export const toPostDto = (view: PostView): PostDto => ({
  ...view,
  createdAt: view.createdAt.toISOString(),
  updatedAt: view.updatedAt.toISOString(),
  variants: view.variants.map(toVariantDto),
});

export const toBrandVoiceDto = (view: BrandVoiceView): BrandVoiceDto => ({
  ...view,
  updatedAt: view.updatedAt.toISOString(),
});

export const toIdeaDto = (view: IdeaView): IdeaDto => ({
  ...view,
  createdAt: view.createdAt.toISOString(),
});
