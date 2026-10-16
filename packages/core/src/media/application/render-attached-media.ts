import { cropHashOf } from '../domain/rules';
import type { RenderJob } from '../ports/media-jobs';
import type { MediaScope } from '../ports/media-store';
import type { MediaDependencies } from './dependencies';
import { RenderRendition } from './render-rendition';

// media.render (guide step 3.4): the rendition of one use of an asset, read again from the
// database. A use that was removed or cropped differently since the job was queued has nothing
// left to do; the job for its new crop covers it.

export type RenderJobOutcome = 'RENDERED' | 'SKIPPED';

export class RenderAttachedMedia {
  private readonly render: RenderRendition;

  constructor(
    private readonly deps: Pick<MediaDependencies, 'unitOfWork' | 'storage' | 'processor' | 'ids'>,
  ) {
    this.render = new RenderRendition(deps);
  }

  async execute(job: RenderJob): Promise<RenderJobOutcome> {
    const scope: MediaScope = {
      userId: null,
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
    };
    const use = await this.deps.unitOfWork.run(scope, (store) =>
      store.postMedia.find(job.workspaceId, job.postMediaId),
    );
    if (!use || use.assetId !== job.assetId || cropHashOf(use.crop, use.letterbox) !== job.cropHash) {
      return 'SKIPPED';
    }
    await this.render.execute({
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
      assetId: use.assetId,
      profile: job.profile,
      crop: use.crop,
      letterbox: use.letterbox,
    });
    return 'RENDERED';
  }
}
