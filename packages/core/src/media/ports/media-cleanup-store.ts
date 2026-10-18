// The assets the clean-up of the media library removes (architecture 9, guide step 8.3, ADR 0038),
// as app_system across workspaces. An asset is expired when no variant uses it and either it was
// removed from the library before deletedBefore or its upload, created before pendingBefore,
// never completed.

export interface ExpiredMediaCutoffs {
  deletedBefore: Date;
  pendingBefore: Date;
}

export interface ExpiredAsset {
  workspaceId: string;
  assetId: string;
}

export interface MediaCleanupStore {
  /** At most limit expired assets, the oldest first. */
  expired(cutoffs: ExpiredMediaCutoffs, limit: number): Promise<ExpiredAsset[]>;
  /**
   * Deletes the rows of these assets and their renditions, each only while it is still expired;
   * returns how many it deleted.
   */
  remove(assetIds: readonly string[], cutoffs: ExpiredMediaCutoffs): Promise<number>;
}
