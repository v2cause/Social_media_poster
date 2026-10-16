import {
  MEDIA_REJECT_REASONS,
  type MediaAsset,
  type MediaRejectReason,
  type MediaRendition,
} from '@smp/core';
import { z } from 'zod';

import type * as Prisma from '../generated/prisma/client';

// Prisma rows to the media entities of the core. The reject reason is free text in the table and
// validated like every other external input (guide B.1).

const rejectReasonSchema = z.enum(MEDIA_REJECT_REASONS).nullable();

export const toRejectReason = (value: string | null): MediaRejectReason | null =>
  rejectReasonSchema.parse(value);

export const toMediaAsset = (row: Prisma.MediaAsset): MediaAsset => ({
  id: row.id,
  workspaceId: row.workspaceId,
  status: row.status,
  fileName: row.fileName,
  declaredMimeType: row.declaredMimeType,
  declaredSize: row.declaredSize,
  storageKey: row.storageKey,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  width: row.width,
  height: row.height,
  sha256: row.sha256,
  rejectReason: toRejectReason(row.rejectReason),
  altText: row.altText,
  uploadedById: row.uploadedById,
  version: row.version,
  processedAt: row.processedAt,
  deletedAt: row.deletedAt,
});

export const toMediaRendition = (row: Prisma.MediaRendition): MediaRendition => ({
  id: row.id,
  workspaceId: row.workspaceId,
  assetId: row.assetId,
  profile: row.profile,
  cropHash: row.cropHash,
  storageKey: row.storageKey,
  mimeType: row.mimeType,
  width: row.width,
  height: row.height,
  sizeBytes: row.sizeBytes,
});
