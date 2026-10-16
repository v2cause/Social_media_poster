import { READ_URL_SECONDS, type StoragePort } from '@smp/core';
import type { MediaAssetView } from '@smp/db';

import type { MediaAssetDto } from './media.dto';

// Views of the read model to the response DTOs: timestamps as ISO strings and the thumbnails
// behind URLs signed for one hour. The storage keys never leave the API.

export async function toMediaAssetDto(view: MediaAssetView, storage: StoragePort): Promise<MediaAssetDto> {
  const thumbnails = await Promise.all(
    view.thumbnails.map(async (thumbnail) => ({
      width: thumbnail.width,
      height: thumbnail.height,
      url: await storage.signedGetUrl(thumbnail.storageKey, { expiresInSeconds: READ_URL_SECONDS }),
    })),
  );
  return {
    id: view.id,
    status: view.status,
    fileName: view.fileName,
    mimeType: view.mimeType,
    sizeBytes: view.sizeBytes,
    width: view.width,
    height: view.height,
    rejectReason: view.rejectReason,
    altText: view.altText,
    usageCount: view.usageCount,
    thumbnails,
    version: view.version,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}
