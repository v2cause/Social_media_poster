// Object keys of the media pipeline (guide step 3.2): ws/{workspaceId}/assets/{assetId}/...
// Every key starts with the workspace, so a whole workspace or asset can be removed by prefix,
// and no key contains a file name the user chose.

/** Everything that belongs to one workspace; the erasure of an organization removes it (step 8.2). */
export const workspacePrefix = (workspaceId: string): string => `ws/${workspaceId}/`;

/** Everything that belongs to one asset. */
export const assetPrefix = (workspaceId: string, assetId: string): string =>
  `${workspacePrefix(workspaceId)}assets/${assetId}/`;

/**
 * The file as the pipeline checked it. Only the pipeline writes it, from the upload, and nothing
 * delivers it; renditions and the export read it.
 */
export const originalKey = (workspaceId: string, assetId: string): string =>
  `${assetPrefix(workspaceId, assetId)}original`;

/**
 * Where the browser uploads the file (guide step 8.4). The pipeline reads it once and deletes it;
 * what the presigned link still sends later lands here, never in the checked original.
 */
export const uploadKey = (workspaceId: string, assetId: string): string =>
  `${assetPrefix(workspaceId, assetId)}upload`;

/** A thumbnail or platform rendition, for example renditions/instagram_feed-full.jpg. */
export const renditionKey = (
  workspaceId: string,
  assetId: string,
  rendition: { profile: string; cropHash: string; extension: string },
): string =>
  `${assetPrefix(workspaceId, assetId)}renditions/${rendition.profile}-${rendition.cropHash}.${rendition.extension}`;
