/** The ids a media job carries; the worker reads everything else from the database. */
export interface MediaJob {
  organizationId: string;
  workspaceId: string;
  assetId: string;
}

/** The queue "media" (architecture 7.4). Implemented in @smp/queue. */
export interface MediaJobs {
  /** Queues media.process for an uploaded asset; queuing the same asset again is harmless. */
  process(job: MediaJob): Promise<void>;
}
