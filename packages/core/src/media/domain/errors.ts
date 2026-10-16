import { DomainError } from '../../shared/domain/errors';
import type { MediaRejectReason } from './types';

export class MediaNotFoundError extends DomainError {
  readonly code = 'MEDIA_NOT_FOUND';
  readonly kind = 'not_found';
  constructor() {
    super('The media item does not exist in this workspace.');
  }
}

export class MediaTypeNotAllowedError extends DomainError {
  readonly code = 'MEDIA_TYPE_NOT_ALLOWED';
  readonly kind = 'invalid';
  constructor() {
    super('Only JPEG, PNG, WebP and static GIF images can be uploaded.');
  }
}

export class MediaTooLargeError extends DomainError {
  readonly code = 'MEDIA_TOO_LARGE';
  readonly kind = 'invalid';
  constructor() {
    super('The file is larger than the upload limit.');
  }
}

export class StorageQuotaExceededError extends DomainError {
  readonly code = 'STORAGE_QUOTA_EXCEEDED';
  readonly kind = 'quota_exceeded';
  constructor() {
    super('The media storage of the workspace is full.');
  }
}

export class UploadMissingError extends DomainError {
  readonly code = 'MEDIA_UPLOAD_MISSING';
  readonly kind = 'conflict';
  constructor() {
    super('The file has not been uploaded yet.');
  }
}

export class MediaInUseError extends DomainError {
  readonly code = 'MEDIA_IN_USE';
  readonly kind = 'conflict';
  constructor() {
    super('The media item is attached to a post and cannot be deleted.');
  }
}

export class MediaNotReadyError extends DomainError {
  readonly code = 'MEDIA_NOT_READY';
  readonly kind = 'conflict';
  constructor() {
    super('The media item is still being processed or was rejected.');
  }
}

export class CropOutOfBoundsError extends DomainError {
  readonly code = 'CROP_OUT_OF_BOUNDS';
  readonly kind = 'invalid';
  constructor() {
    super('The crop does not lie inside the image.');
  }
}

/** More media than a variant holds, or one asset twice. The API schema refuses both first. */
export class VariantMediaInvalidError extends DomainError {
  readonly code = 'VARIANT_MEDIA_INVALID';
  readonly kind = 'invalid';
  constructor() {
    super('A variant holds at most 20 media items, each asset once.');
  }
}

/**
 * A rendition the profile does not allow, for example a crop outside the aspect ratio of the
 * platform without letterbox. Not a DomainError: the attachment was checked before, so a job
 * that meets it has nothing left to do.
 */
export class RenditionNotPossibleError extends Error {
  constructor(readonly issue: 'CROP_OUT_OF_BOUNDS' | 'ASPECT_RATIO_OUT_OF_RANGE') {
    super(`The rendition is not possible: ${issue}`);
    this.name = 'RenditionNotPossibleError';
  }
}

/** Even the lowest quality and size of a profile exceed its byte limit. */
export class RenditionTooLargeError extends Error {
  constructor(readonly profile: string) {
    super(`The rendition for ${profile} stays above the byte limit of the profile.`);
    this.name = 'RenditionTooLargeError';
  }
}

/**
 * Thrown by an ImageProcessor for an image it refuses, for example one it cannot decode or one
 * with too many pixels. Not a DomainError: the pipeline turns it into a rejected asset.
 */
export class ImageRejectedError extends Error {
  constructor(readonly reason: MediaRejectReason) {
    super(`The image was rejected: ${reason}`);
    this.name = 'ImageRejectedError';
  }
}
