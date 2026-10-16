// Object keys of the media pipeline (guide step 3.2): ws/{workspaceId}/assets/{assetId}/...
// Every key starts with the workspace, so a whole workspace or asset can be removed by prefix,
// and no key contains a file name the user chose.

/** Everything that belongs to one asset. */
export const assetPrefix = (workspaceId: string, assetId: string): string =>
  `ws/${workspaceId}/assets/${assetId}/`;

/** The uploaded file; only the pipeline reads it, it is never delivered. */
export const originalKey = (workspaceId: string, assetId: string): string =>
  `${assetPrefix(workspaceId, assetId)}original`;

/** A thumbnail or platform rendition, for example renditions/instagram_feed-full.jpg. */
export const renditionKey = (
  workspaceId: string,
  assetId: string,
  rendition: { profile: string; cropHash: string; extension: string },
): string =>
  `${assetPrefix(workspaceId, assetId)}renditions/${rendition.profile}-${rendition.cropHash}.${rendition.extension}`;
