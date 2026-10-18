import type { ContentActor } from '../../content/domain/types';
import { MediaInUseError, MediaNotFoundError } from '../domain/errors';
import { assertCanWriteMedia, mediaScopeOf, type MediaDependencies } from './dependencies';

// Removes an asset from the library (architecture 9). An asset a variant still uses stays; the
// user detaches it first. CleanUpMedia deletes its files and its row 30 days later.

export interface DeleteMediaInput {
  actor: ContentActor;
  assetId: string;
}

export class DeleteMedia {
  constructor(private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'clock'>) {}

  async execute(input: DeleteMediaInput): Promise<void> {
    const { actor } = input;
    assertCanWriteMedia(actor);
    await this.deps.unitOfWork.run(mediaScopeOf(actor), async (store) => {
      const asset = await store.assets.find(actor.workspaceId, input.assetId);
      if (!asset || asset.deletedAt !== null) {
        throw new MediaNotFoundError();
      }
      if ((await store.assets.usageCount(actor.workspaceId, asset.id)) > 0) {
        throw new MediaInUseError();
      }
      await store.assets.markDeleted(actor.workspaceId, asset.id, this.deps.clock.now());
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'media.delete',
        targetType: 'MediaAsset',
        targetId: asset.id,
      });
    });
  }
}
