import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { MediaAsset, MediaRejectReason, MediaRendition, ProcessedAsset } from '../domain/types';

// The repositories of the media context (guide step 3.3). Every method names the workspace;
// row-level security limits the statements to it as well (architecture 6.3).

export interface MediaAssetRepository {
  /** An asset of the workspace, deleted ones included. */
  find(workspaceId: string, assetId: string): Promise<MediaAsset | null>;
  insert(asset: MediaAsset): Promise<void>;
  /** Waits for other uploads of the workspace, so the quota check and the insert are atomic. */
  lockStorage(workspaceId: string): Promise<void>;
  /** The bytes the workspace stores: every asset neither deleted nor rejected. */
  storageUsed(workspaceId: string): Promise<number>;
  /** PENDING_UPLOAD to PROCESSING with the measured size; false when it was not pending. */
  startProcessing(workspaceId: string, assetId: string, sizeBytes: number): Promise<boolean>;
  /** PROCESSING to READY; false when it was not processing. */
  finishProcessing(workspaceId: string, assetId: string, result: ProcessedAsset): Promise<boolean>;
  /** To REJECTED from PENDING_UPLOAD or PROCESSING; false otherwise. */
  reject(
    workspaceId: string,
    assetId: string,
    reason: MediaRejectReason,
    sizeBytes: number | null,
  ): Promise<boolean>;
  /** Changes the alt text if the version is current; false otherwise. */
  updateAltText(
    workspaceId: string,
    assetId: string,
    version: number,
    altText: string | null,
  ): Promise<boolean>;
  markDeleted(workspaceId: string, assetId: string, deletedAt: Date): Promise<void>;
  /** How many variants use the asset. */
  usageCount(workspaceId: string, assetId: string): Promise<number>;
}

export interface MediaRenditionRepository {
  find(
    workspaceId: string,
    assetId: string,
    profile: string,
    cropHash: string,
  ): Promise<MediaRendition | null>;
  /** Inserts the rendition or replaces the one with the same asset, profile and crop. */
  upsert(rendition: MediaRendition): Promise<void>;
}

/** The repositories of one transaction. */
export interface MediaStore {
  assets: MediaAssetRepository;
  renditions: MediaRenditionRepository;
  audit: AuditTrail;
}

/** The tenant of a unit of work. Jobs of the worker act without a user. */
export interface MediaScope {
  userId: string | null;
  organizationId: string;
  workspaceId: string;
}

export interface MediaUnitOfWork {
  run<T>(scope: MediaScope, work: (store: MediaStore) => Promise<T>): Promise<T>;
}
