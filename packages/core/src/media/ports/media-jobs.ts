import type { RenditionProfileKey } from '@smp/platform-rules';

/** The ids a media job carries; the worker reads everything else from the database. */
export interface MediaJob {
  organizationId: string;
  workspaceId: string;
  assetId: string;
}

/** media.render: the rendition of one use of an asset for the profile of its platform. */
export interface RenderJob extends MediaJob {
  postMediaId: string;
  profile: RenditionProfileKey;
  /** The crop and letterbox the job was queued for; a job for an older crop has nothing to do. */
  cropHash: string;
}

/** The queue "media" (architecture 7.4). Implemented in @smp/queue. */
export interface MediaJobs {
  /** Queues media.process for an uploaded asset; queuing the same asset again is harmless. */
  process(job: MediaJob): Promise<void>;
  /** Queues media.render; one job per asset, profile and crop. */
  render(job: RenderJob): Promise<void>;
}
