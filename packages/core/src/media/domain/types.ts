// Media entities (guide step 3.1, architecture 9) as the use cases see them.

export const MEDIA_STATUSES = ['PENDING_UPLOAD', 'PROCESSING', 'READY', 'REJECTED'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** Why the pipeline refused a file. The UI translates the code. */
export const MEDIA_REJECT_REASONS = [
  // The stored object differs from what the browser announced.
  'SIZE_MISMATCH',
  'TYPE_MISMATCH',
  // The content is no image, or none the pipeline takes.
  'NOT_AN_IMAGE',
  'UNSUPPORTED_FORMAT',
  'HEIC_NOT_SUPPORTED',
  'ANIMATED_NOT_SUPPORTED',
  'DIMENSIONS_TOO_LARGE',
  'CORRUPT_IMAGE',
] as const;
export type MediaRejectReason = (typeof MEDIA_REJECT_REASONS)[number];

export interface MediaAsset {
  id: string;
  workspaceId: string;
  status: MediaStatus;
  /** The name of the user's file, for display only. */
  fileName: string;
  declaredMimeType: string;
  declaredSize: number;
  storageKey: string;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  rejectReason: MediaRejectReason | null;
  altText: string | null;
  uploadedById: string | null;
  version: number;
  processedAt: Date | null;
  deletedAt: Date | null;
}

/** A thumbnail or the version of an asset for a platform. */
export interface MediaRendition {
  id: string;
  workspaceId: string;
  assetId: string;
  /** A profile of @smp/platform-rules, for example thumb_320. */
  profile: string;
  /** The hash of crop and fit; "full" for the whole image. */
  cropHash: string;
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/** What the pipeline measured on an accepted file. */
export interface ProcessedAsset {
  mimeType: string;
  width: number;
  height: number;
  sha256: string;
  processedAt: Date;
}

/** A region in pixels of the image as it is shown, after the EXIF orientation. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An asset in a variant: its place, and crop, letterbox and alt text for this use. */
export interface PostMedia {
  id: string;
  workspaceId: string;
  variantId: string;
  assetId: string;
  /** 0, 1, ... in the order the platform shows them. */
  position: number;
  /** The region the platform gets; null for the whole image. */
  crop: Crop | null;
  /** White bars instead of a crop where the image does not fit the aspect ratio of the platform. */
  letterbox: boolean;
  /** The alt text of this use; null takes the alt text of the asset. */
  altText: string | null;
}
