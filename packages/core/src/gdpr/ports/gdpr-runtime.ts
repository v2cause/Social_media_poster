import type { SocialConnection } from '../../channels/domain/types';

// What the worker role "gdpr" needs to export and to erase an organization (guide steps 8.1 and
// 8.2, ADR 0036 and 0037), all as app_system.

export interface ExportedOrganization {
  id: string;
  name: string;
  workspaces: { id: string; slug: string; name: string }[];
}

/** An original of the media library, as the export packs it. */
export interface ExportedMedia {
  workspaceSlug: string;
  assetId: string;
  fileName: string;
  storageKey: string;
}

/** The data of an organization, table by table, without secrets. */
export interface OrganizationDataSource {
  organization(organizationId: string): Promise<ExportedOrganization | null>;
  /** The tables the export holds, in a fixed order. */
  tables(): readonly string[];
  /**
   * The rows of one table that belong to the organization, page by page, each as one serialized
   * JSON object, so that large numbers keep every digit.
   */
  rows(table: string, organization: ExportedOrganization): AsyncIterable<string>;
  /** The originals of the media library. */
  media(organization: ExportedOrganization): AsyncIterable<ExportedMedia>;
}

/** An archive being written to the object storage. */
export interface ExportArchive {
  /** Adds a JSON array of serialized JSON values and returns how many there were. */
  addJsonArray(name: string, items: AsyncIterable<string>): Promise<number>;
  /** Adds a file; compress is false for files that are compressed already, such as images. */
  addFile(name: string, body: Uint8Array, options?: { compress?: boolean }): Promise<void>;
  /** Closes the archive and waits until it is stored. */
  finish(): Promise<{ bytes: number }>;
  /** Drops what was written so far. */
  abort(): Promise<void>;
}

export interface ExportArchives {
  create(key: string): ExportArchive;
}

/** What the owners hear about their requests. */
export interface GdprNotifier {
  /** To the owner who asked, or to every owner when that one is gone: until when it can be downloaded. */
  exportReady(notice: {
    requestId: string;
    organizationId: string;
    requestedById: string | null;
    expiresAt: Date;
  }): Promise<void>;
  /** To every owner: the organization will be erased on this day unless one of them takes it back. */
  erasureScheduled(notice: { requestId: string; organizationId: string; eraseAfter: Date }): Promise<void>;
}

/** The parts of an organization the erasure removes, as app_system. */
export interface OrganizationEraser {
  /** The connections with their sealed tokens, to revoke the grants at the platforms. */
  connections(organizationId: string): Promise<SocialConnection[]>;
  /** The customer at the payment provider, or null. */
  billingCustomerOf(organizationId: string): Promise<string | null>;
  /**
   * Deletes every row of the organization and of its workspaces in one transaction and returns
   * how many rows each table lost. The erasure request itself stays.
   */
  erase(
    organizationId: string,
    workspaceIds: readonly string[],
    keepRequestId: string,
  ): Promise<Record<string, number>>;
  /**
   * Rows that still name the organization or one of its workspaces, and the webhook events of its
   * customer at the payment provider, per table; empty when none. The customer is given once the
   * erasure deleted it, when the subscription that named it is gone.
   */
  leftovers(
    organizationId: string,
    workspaceIds: readonly string[],
    keepRequestId: string,
    customerId: string | null,
  ): Promise<Record<string, number>>;
}

/** Revokes the grant of one connection at its platform; throws when the platform refuses. */
export type GrantRevoker = (connection: SocialConnection) => Promise<void>;
