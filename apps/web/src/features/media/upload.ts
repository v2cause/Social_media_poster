import { mediaComplete, mediaUpload } from '@smp/api-client';
import {
  MEDIA_MAX_UPLOAD_BYTES,
  MEDIA_UPLOAD_MIME_TYPES,
  type ErrorCode,
  type MediaAssetDto,
  type UploadTicketDto,
} from '@smp/contracts';

// Uploads straight into the object storage (guide step 3.6, architecture 9): the API hands out a
// presigned PUT, the browser sends the file there with XHR, whose upload events report the
// progress, and then reports the upload complete. The server checks type and size again.

/** The error code for a file the API would refuse anyway, or null when it may go up. */
export function checkFile(file: { type: string; size: number }): ErrorCode | null {
  if (!(MEDIA_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase())) {
    return 'MEDIA_TYPE_NOT_ALLOWED';
  }
  if (file.size <= 0 || file.size > MEDIA_MAX_UPLOAD_BYTES) {
    return 'MEDIA_TOO_LARGE';
  }
  return null;
}

/** The storage refused the upload or could not be reached. */
export class StorageUploadError extends Error {
  constructor(readonly status: number) {
    super(`The upload to the storage failed with status ${String(status)}.`);
    this.name = 'StorageUploadError';
  }
}

/** Sends the file to the presigned URL with exactly the signed headers. */
export function putFile(
  upload: UploadTicketDto['upload'],
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new StorageUploadError(request.status));
      }
    };
    request.onerror = () => {
      reject(new StorageUploadError(0));
    };
    request.onabort = () => {
      reject(new DOMException('The upload was canceled.', 'AbortError'));
    };
    signal?.addEventListener(
      'abort',
      () => {
        request.abort();
      },
      { once: true },
    );
    request.send(file);
  });
}

/** Ticket, upload and completion; the asset comes back processing or already decided. */
export async function uploadMedia(
  ws: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<MediaAssetDto> {
  const options = signal ? { signal } : undefined;
  const ticket = await mediaUpload(
    ws,
    { fileName: file.name, mimeType: file.type, size: file.size },
    options,
  );
  await putFile(ticket.upload, file, onProgress, signal);
  return mediaComplete(ws, ticket.asset.id, options);
}
