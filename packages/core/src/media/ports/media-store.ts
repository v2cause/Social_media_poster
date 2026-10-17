import type { Platform } from '@smp/platform-rules';

import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { VariantStatus } from '../../content/domain/types';
import type {
  MediaAsset,
  MediaRejectReason,
  MediaRendition,
  PostMedia,
  ProcessedAsset,
} from '../domain/types';

// The repositories of the media context (guide step 3.3). Every method names the workspace;
// row-level security limits the statements to it as well (architecture 6.3).

export interface MediaAssetRepository {
  /** An asset of the workspace, deleted ones included. */
  find(workspaceId: string, assetId: string): Promise<MediaAsset | null>;
  insert(asset: MediaAsset): Promise<void>;
  /**
   * Waits for other uploads of the organization, in all its workspaces, so that the check of the
   * storage of its plan and the insert are atomic (guide step 7.4).
   */
  lockStorage(organizationId: string): Promise<void>;
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

export interface PostMediaRepository {
  find(workspaceId: string, postMediaId: string): Promise<PostMedia | null>;
  /** The media of a variant in their order. */
  ofVariant(workspaceId: string, variantId: string): Promise<PostMedia[]>;
  /** Replaces all media of a variant. */
  replace(workspaceId: string, variantId: string, items: readonly PostMedia[]): Promise<void>;
}

/** What the media context needs to know of a variant. */
export interface VariantRef {
  id: string;
  platform: Platform;
  status: VariantStatus;
  version: number;
}

export interface VariantRefRepository {
  find(workspaceId: string, variantId: string): Promise<VariantRef | null>;
  /** Raises the version of the variant if it is current; false otherwise. */
  touch(workspaceId: string, variantId: string, version: number): Promise<boolean>;
}

/** The repositories of one transaction. */
export interface MediaStore {
  assets: MediaAssetRepository;
  renditions: MediaRenditionRepository;
  postMedia: PostMediaRepository;
  variants: VariantRefRepository;
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
