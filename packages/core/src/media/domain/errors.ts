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
