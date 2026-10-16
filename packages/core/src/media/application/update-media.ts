import type { ContentActor } from '../../content/domain/types';
import { VersionConflictError } from '../../content/domain/errors';
import { MediaNotFoundError } from '../domain/errors';
import type { MediaAsset } from '../domain/types';
import { assertCanWriteMedia, mediaScopeOf, type MediaDependencies } from './dependencies';

// The alt text of an asset (guide step 3.3): what screen readers announce for the image. Every
// variant takes it unless it sets its own. Optimistic locking as everywhere else.

export interface UpdateMediaAltTextInput {
  actor: ContentActor;
  assetId: string;
  version: number;
  altText: string | null;
}

export class UpdateMediaAltText {
  constructor(private readonly deps: Pick<MediaDependencies, 'unitOfWork'>) {}

  async execute(input: UpdateMediaAltTextInput): Promise<MediaAsset> {
    const { actor } = input;
    assertCanWriteMedia(actor);
    const altText = input.altText?.trim() ? input.altText.trim() : null;
    return this.deps.unitOfWork.run(mediaScopeOf(actor), async (store) => {
      const asset = await store.assets.find(actor.workspaceId, input.assetId);
      if (!asset || asset.deletedAt !== null) {
        throw new MediaNotFoundError();
      }
      if (!(await store.assets.updateAltText(actor.workspaceId, asset.id, input.version, altText))) {
        throw new VersionConflictError();
      }
      return { ...asset, altText, version: asset.version + 1 };
    });
  }
}
