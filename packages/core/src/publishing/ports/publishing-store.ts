import type { Crop, Platform } from '@smp/platform-rules';

import type { AuditTrail } from '../../audit/ports/audit-trail';
import type { ConnectionStatus } from '../../channels/domain/types';
import type { VariantStatus } from '../../content/domain/types';
import type { OutboxEventInput } from '../../shared/domain/outbox';

// The repositories of the publishing context (guide step 4.6). Every method names the workspace;
// row-level security limits the statements to it as well (architecture 6.3).

/** A variant as planning sees it. */
export interface SchedulableVariant {
  id: string;
  workspaceId: string;
  postId: string;
  platform: Platform;
  status: VariantStatus;
  version: number;
  scheduleVersion: number;
  socialAccountId: string | null;
  text: string;
  hashtags: string[];
  firstComment: string | null;
  scheduledAt: Date | null;
  scheduledTimezone: string | null;
}

/** An account with the state of its connection. */
export interface PublishingTarget {
  id: string;
  platform: Platform;
  disconnectedAt: Date | null;
  connectionStatus: ConnectionStatus;
  /** When the user has to grant access again; null when it does not expire. */
  accessExpiresAt: Date | null;
}

/** A status change of a planning use case; the schedule version always goes up. */
export interface ScheduleChange {
  status: VariantStatus;
  scheduledAt: Date | null;
  scheduledTimezone: string | null;
  socialAccountId: string | null;
  /** Set when the variant goes to QUEUED, for the sweeper. */
  queuedAt: Date | null;
}

export interface PublishingVariantRepository {
  find(workspaceId: string, variantId: string): Promise<SchedulableVariant | null>;
  /**
   * Waits for other plannings of the organization, in all its workspaces, until the transaction
   * ends, so that the check of the posts per month of its plan and the change are atomic (guide
   * step 8.4).
   */
  lockPostLimit(organizationId: string): Promise<void>;
  /**
   * Applies the change if the version is current, clears the error of a former attempt and
   * raises version and schedule version. Returns the new schedule version, or null when the
   * variant changed meanwhile.
   */
  change(
    workspaceId: string,
    variantId: string,
    version: number,
    change: ScheduleChange,
  ): Promise<{ scheduleVersion: number } | null>;
}

export interface PublishingTargetRepository {
  find(workspaceId: string, accountId: string): Promise<PublishingTarget | null>;
}

/** An attached image as the rendition for the platform will be made from it. */
export interface VariantMediaSource {
  mimeType: string;
  width: number;
  height: number;
  crop: Crop | null;
  letterbox: boolean;
}

export interface VariantMediaReader {
  /** The media of a variant in their order. */
  sourcesOf(workspaceId: string, variantId: string): Promise<VariantMediaSource[]>;
}

export interface OutboxWriter {
  add(workspaceId: string, event: OutboxEventInput): Promise<void>;
}

/** The repositories of one transaction. */
export interface PublishingStore {
  variants: PublishingVariantRepository;
  targets: PublishingTargetRepository;
  media: VariantMediaReader;
  outbox: OutboxWriter;
  audit: AuditTrail;
}

export interface PublishingScope {
  userId: string;
  organizationId: string;
  workspaceId: string;
}

export interface PublishingUnitOfWork {
  run<T>(scope: PublishingScope, work: (store: PublishingStore) => Promise<T>): Promise<T>;
}
